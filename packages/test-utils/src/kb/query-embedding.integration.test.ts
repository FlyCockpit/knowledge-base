import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { QUERY_EMBEDDING_DEADLINE_MS } from "@knowledge-base/api/lib/kb/embed-breaker";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import {
  activateIndexBuild,
  indexBuildSnapshotSchema,
  requestIndexBuild,
} from "@knowledge-base/api/lib/kb/generations";
import { claimDispatchBatch } from "@knowledge-base/api/lib/kb/jobs";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import type { TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import { createProvider, revokeProvider } from "@knowledge-base/api/lib/kb/providers";
import type { QueryEmbeddingOptions } from "@knowledge-base/api/lib/kb/query-embedding";
import {
  beginQueryEmbedding,
  cancelQueryEmbedding,
  degradableKind,
  dispatchQueryEmbedding,
  takeQueryEmbedding,
  withQueryEmbedding,
} from "@knowledge-base/api/lib/kb/query-embedding";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
  mintPersonalToken,
  revokeGrant,
  revokePersonalToken,
} from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import type { PrismaClient } from "@knowledge-base/db/client";
import { Queue, Worker } from "bullmq";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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

import { startPublicHttpFixture } from "./http-fixture";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: wire.request }));
/** Test seam: runs once while the provider request is in flight, before the reply. */
let beforeReply: (() => Promise<void>) | null = null;
const http = await startPublicHttpFixture({
  handler: (_req, res) => {
    const reply = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }));
    };
    const hook = beforeReply;
    beforeReply = null;
    if (hook) void hook().then(reply, reply);
    else reply();
  },
});
wire.request.mockImplementation((url: URL, options: RequestOptions) => {
  if (url.hostname !== "provider.example.invalid") throw new Error("Unexpected fixture host");
  return httpRequest(`${http.origin}${url.pathname}`, { ...options, lookup: undefined });
});
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
const redis = openKbRedisFromEnv();
const connection = redis.client();
const prefix = redis.key("bull");
const queue = new Queue("query-embedding", { connection, prefix });
// Leased query vectors are the provider's RAW values: the index reader normalizes exactly once.
const opts = {
  connectionString: db.urls.runtime,
  masterKey: Buffer.alloc(32, 25).toString("base64"),
  ratePort: createMemoryRatePort(),
};
const id = () => `q${randomUUID().replaceAll("-", "").slice(0, 23)}`;
const key = () => randomUUID().replaceAll("-", "");
const tx = <T>(run: (q: LockQuery) => Promise<T>) =>
  runLockedOperation({
    connectionString: db.urls.runtime,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) => lease.transaction(run),
  });
const runtime: KbRuntimeConfig = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir: "/unused",
  assetsDir: "/unused",
  blobStore: createDiskBlobStore("/unused"),
  canonicalOrigin: "https://kb.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: opts.ratePort,
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
              throw new Error("Unused");
            },
          }),
      }),
  },
};
function barrier() {
  let release = () => {};
  let enter = () => {};
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await blocked;
    },
  };
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
async function fixture(active = true) {
  const owner = await user();
  const reader = await user();
  const kbId = id();
  await prisma.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: owner.id,
      name: "Fixture",
      slug: id(),
      description: "Query fixture KB",
      state: "ACTIVE",
      headSha: "a".repeat(40),
    },
  });
  await prisma.kbShare.create({ data: { kbId, userId: reader.id, bits: ["read"] } });
  const created = await createProvider(
    runtime,
    owner.id,
    {
      name: "Fixture",
      model: "fixture",
      endpointUrl: "https://provider.example.invalid/embeddings",
      dimensions: 2,
      apiKey: "test-only-query-key",
      idempotencyKey: key(),
    },
    opts.masterKey,
  );
  await prisma.durableJob.update({ where: { id: created.jobId }, data: { state: "COMPLETE" } });
  const actor = { principal: { kind: "browser" as const, userId: reader.id } };
  const build = async () => {
    const b = await requestIndexBuild(
      runtime,
      { principal: { kind: "browser", userId: owner.id } },
      {
        kbId,
        providerId: created.provider.providerId,
        revision: 1,
        confirm: "RUN",
        idempotencyKey: key(),
      },
    );
    await prisma.durableJob.update({
      where: { id: b.jobId },
      data: {
        state: "RUNNING",
        workerOwner: "fixture-builder",
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    await prisma.indexGeneration.update({
      where: { id: b.generationId },
      data: { state: "BUILDING" },
    });
    await prisma.indexGeneration.update({
      where: { id: b.generationId },
      data: { state: "INDEXING" },
    });
    const job = await prisma.durableJob.findUniqueOrThrow({ where: { id: b.jobId } });
    await tx((q) =>
      activateIndexBuild(q, indexBuildSnapshotSchema.parse(job.desired), {
        jobId: job.id,
        workerId: "fixture-builder",
        epoch: 1,
      }),
    );
    return b.generationId;
  };
  const generationId = active ? await build() : null;
  return {
    owner,
    reader,
    kbId,
    actor,
    providerId: created.provider.providerId,
    generationId,
    build,
  };
}
async function publish() {
  await runDurableDispatcherCycle({
    db: prisma,
    ownerId: "query-test",
    now: () => new Date(),
    getQueue: () => queue,
  });
}
async function run(
  id: string,
  embedder: Parameters<typeof runQueryEmbeddingDelivery>[1]["embedder"] = {
    embed: async (_texts, o) => {
      await o.beforeDispatch?.();
      return [[3, 4]];
    },
  },
) {
  await publish();
  return runQueryEmbeddingDelivery(prisma, {
    ...opts,
    durableJobId: id,
    workerId: randomUUID(),
    embedder,
  });
}
const row = (id: string) => prisma.queryEmbeddingRequest.findUniqueOrThrow({ where: { id } });
const begin = (f: Awaited<ReturnType<typeof fixture>>) =>
  beginQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: "private query words" });
afterAll(async () => {
  await http.close();
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
});

describe("leased query embeddings", () => {
  it("starts the first published delivery without waiting for the dispatcher poll", async () => {
    const f = await fixture();
    const deliveries: Array<{ accepted?: boolean; skipped?: boolean }> = [];
    const samples: Array<{ totalMs: number; enqueueToStartMs: number }> = [];
    let delivered: (() => void) | undefined;
    let enqueueToStartMs = 0;
    const worker = new Worker(
      "query-embedding",
      async (job) => {
        // Both stamps come from BullMQ's enqueue/activation path. Measuring
        // before publication also counts producer DB/Redis setup, and timing
        // this JS callback counts host scheduling after Redis activated it.
        enqueueToStartMs = job.processedOn! - job.timestamp;
        const result = await runQueryEmbeddingDelivery(prisma, {
          ...opts,
          durableJobId: job.data.durableJobId,
          workerId: randomUUID(),
          embedder: { embed: async () => [[3, 4]] },
        });
        deliveries.push(result);
        return result;
      },
      { connection: { url: redis.url, maxRetriesPerRequest: null }, prefix, concurrency: 4 },
    );
    worker.on("completed", () => delivered?.());
    try {
      await once(worker, "drained");
      for (let n = 0; n < 6; n++) {
        const beganAt = Date.now();
        const request = await begin(f);
        const done = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        await runDurableDispatcherCycle({
          db: prisma,
          ownerId: "latency-test",
          now: () => new Date(),
          getQueue: (name) => {
            if (name !== "query-embedding") throw new Error("Not this consumer's queue");
            return queue;
          },
          hooks: {
            // A delivery may finish before Queue.add's caller resumes. Force that
            // ordering: the durable state must already admit this first delivery.
            afterPublish: (id) => (id === request.id ? done : undefined),
          },
        });
        samples.push({ totalMs: Date.now() - beganAt, enqueueToStartMs });
        console.info("query delivery timing", samples.at(-1), deliveries.at(-1));
        expect(deliveries.at(-1)).toEqual({ accepted: true });
        expect(enqueueToStartMs).toBeLessThan(250);
        expect((await row(request.id)).state).toBe("READY");
        await cancelQueryEmbedding(opts, f.actor, request.id);
      }
    } finally {
      await worker.close();
    }
  });
  it.each(["never", "dated", "oauth"] as const)(
    "%s credential survives real enqueue/worker/take with its full binding",
    async (kind) => {
      const f = await fixture();
      const q = prismaAssetQuery(prisma);
      let principal: TokenPrincipal;
      if (kind === "oauth") {
        const g = await prisma.mcpGrant.create({
          data: {
            id: randomUUID(),
            kind: "OAUTH",
            actorUserIdSnapshot: f.reader.id,
            userId: f.reader.id,
            clientId: "query-client",
            referenceId: randomUUID(),
            scopes: ["mcp:read"],
            toolGroups: ["read"],
            createdKbBits: [],
            acl: { create: { kbId: f.kbId, bits: ["read"] } },
          },
        });
        principal = {
          kind: "token",
          userId: f.reader.id,
          grantId: g.id,
          grantGeneration: g.id,
          scopes: g.scopes,
          expiresAt: new Date(Date.now() + 600_000),
          storedAcl: new Map(),
          credential: {
            kind: "OAUTH",
            clientId: g.clientId,
            resource: `${runtime.canonicalOrigin}/mcp`,
          },
        };
      } else {
        const minted = await mintPersonalToken(runtime, f.reader.id, {
          name: "query",
          scopes: ["mcp:read"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [{ kbId: f.kbId, bits: ["read"] }],
          expiresAt: kind === "never" ? null : new Date(Date.now() + 600_000),
        });
        principal = (await authenticatePersonalToken(q, minted.secret, new Date()))!;
      }
      const actor = { principal, verifier: createGrantCredentialVerifier(q) };
      const r = await beginQueryEmbedding(opts, actor, {
        kbId: f.kbId,
        query: "private query words",
      });
      const persisted = (await row(r.id)).principal;
      expect(persisted).toMatchObject({
        expiresAt: principal.expiresAt?.toISOString() ?? null,
        credential: principal.credential,
      });
      await expect(run(r.id)).resolves.toEqual({ accepted: true });
      expect((await takeQueryEmbedding(opts, actor, r.id))?.vector).toEqual([3, 4]);
      await cancelQueryEmbedding(opts, actor, r.id);
      if (kind === "oauth") {
        const next = await beginQueryEmbedding(opts, actor, {
          kbId: f.kbId,
          query: "private query words",
        });
        const persisted = (await row(next.id)).principal;
        await prisma.queryEmbeddingRequest.update({
          where: { id: next.id },
          data: { principal: { ...JSON.parse(JSON.stringify(persisted)), expiresAt: null } },
        });
        const embed = { embed: vi.fn(async () => [[3, 4]]) };
        await expect(run(next.id, embed)).rejects.toBeDefined();
        expect(embed.embed).not.toHaveBeenCalled();
        await expect(takeQueryEmbedding(opts, actor, next.id)).rejects.toBeDefined();
        await cancelQueryEmbedding(opts, actor, next.id);
      }
    },
  );
  it.each(["expired", "revoked", "binding", "malformed"] as const)(
    "%s durable PAT cannot dispatch private work",
    async (loss) => {
      const f = await fixture();
      const minted = await mintPersonalToken(runtime, f.reader.id, {
        name: "query",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: f.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const q = prismaAssetQuery(prisma);
      const principal = (await authenticatePersonalToken(q, minted.secret, new Date()))!;
      const actor = { principal, verifier: createGrantCredentialVerifier(q) };
      const r = await beginQueryEmbedding(opts, actor, {
        kbId: f.kbId,
        query: "private query words",
      });
      if (loss === "expired")
        await prisma.mcpPersonalToken.update({
          where: { id: minted.token.id },
          data: { expiresAt: new Date(0) },
        });
      else if (loss === "revoked") await revokePersonalToken(runtime, f.reader.id, minted.token.id);
      else {
        await prisma.queryEmbeddingRequest.update({
          where: { id: r.id },
          data: {
            principal: JSON.parse(
              JSON.stringify({
                ...principal,
                storedAcl: [],
                toolGroupDemands: [["read"]],
                ...(loss === "binding"
                  ? { credential: { ...principal.credential, tokenId: "foreign" } }
                  : { expiresAt: "not-a-date" }),
              }),
            ),
          },
        });
      }
      const embed = { embed: vi.fn(async () => [[0.6, 0.8]]) };
      await expect(run(r.id, embed)).rejects.toBeDefined();
      expect(embed.embed).not.toHaveBeenCalled();
      await expect(takeQueryEmbedding(opts, actor, r.id)).rejects.toBeDefined();
      await cancelQueryEmbedding(opts, actor, r.id);
    },
  );

  it.each(["dispatch", "ready"])(
    "live PAT loss at %s blocks worker result/private take",
    async (phase) => {
      const f = await fixture();
      const minted = await mintPersonalToken(runtime, f.reader.id, {
        name: "query",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: f.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const q = prismaAssetQuery(prisma);
      const actor = {
        principal: (await authenticatePersonalToken(q, minted.secret, new Date()))!,
        verifier: createGrantCredentialVerifier(q),
      };
      const r = await beginQueryEmbedding(opts, actor, {
        kbId: f.kbId,
        query: "private query words",
      });
      if (phase === "dispatch") {
        const embed = {
          embed: vi.fn(async (_text, guard) => {
            await guard.beforeDispatch?.();
            await revokePersonalToken(runtime, f.reader.id, minted.token.id);
            return [[3, 4]];
          }),
        } satisfies Embedder;
        await expect(run(r.id, embed)).rejects.toBeDefined();
        expect(embed.embed).toHaveBeenCalledOnce();
      } else {
        await expect(run(r.id)).resolves.toEqual({ accepted: true });
        await revokePersonalToken(runtime, f.reader.id, minted.token.id);
      }
      await expect(takeQueryEmbedding(opts, actor, r.id)).rejects.toBeDefined();
      expect((await row(r.id)).resultCiphertext).toBeNull();
      await cancelQueryEmbedding(opts, actor, r.id);
    },
  );
  it.each(["queued", "before provider dispatch", "missing demands"] as const)(
    "removing only the read tool group (%s) keeps the query from the provider and the result from the caller",
    async (phase) => {
      const f = await fixture();
      const minted = await mintPersonalToken(runtime, f.reader.id, {
        name: "query",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: f.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const q = prismaAssetQuery(prisma);
      const principal = (await authenticatePersonalToken(q, minted.secret, new Date()))!;
      const actor = { principal, verifier: createGrantCredentialVerifier(q) };
      const r = await beginQueryEmbedding(opts, actor, {
        kbId: f.kbId,
        query: "private query words",
      });
      // Enqueue persisted the demand the worker restores and enforces.
      expect((await row(r.id)).principal).toMatchObject({ toolGroupDemands: [["read"]] });
      const removeRead = () =>
        prisma.mcpGrant.update({
          where: { id: principal.grantId },
          data: { toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "read") },
        });
      if (phase === "queued") await removeRead();
      if (phase === "missing demands") {
        const { toolGroupDemands: _dropped, ...stored } = (await row(r.id)).principal as Record<
          string,
          unknown
        >;
        await prisma.queryEmbeddingRequest.update({
          where: { id: r.id },
          data: { principal: JSON.parse(JSON.stringify(stored)) },
        });
      }
      let sent = false;
      const embed = {
        embed: vi.fn(async (_text, guard) => {
          if (phase === "before provider dispatch") await removeRead();
          await guard.beforeDispatch?.();
          sent = true;
          return [[3, 4]];
        }),
      } satisfies Embedder;
      await expect(run(r.id, embed)).rejects.toBeDefined();
      expect(sent).toBe(false);
      if (phase !== "before provider dispatch") expect(embed.embed).not.toHaveBeenCalled();
      expect((await row(r.id)).resultCiphertext).toBeNull();
      await expect(takeQueryEmbedding(opts, actor, r.id)).rejects.toBeDefined();
      await cancelQueryEmbedding(opts, actor, r.id);
    },
  );
  it("executes the production OpenAI query adapter with the leased profile", async () => {
    const f = await fixture();
    const r = await begin(f);
    await publish();
    const before = http.requests.length;
    expect(
      await runQueryEmbeddingDelivery(prisma, {
        ...opts,
        durableJobId: r.id,
        workerId: "production-adapter",
      }),
    ).toEqual({ accepted: true });
    expect(http.requests.slice(before).map((r) => JSON.parse(r.body))).toEqual([
      { model: "fixture", input: ["private query words"], dimensions: 2, encoding_format: "float" },
    ]);
    expect((await takeQueryEmbedding(opts, f.actor, r.id))?.vector).toEqual([3, 4]);
    await cancelQueryEmbedding(opts, f.actor, r.id);
  });
  // Closed classification at the adapter boundary: the production provider adapter's own
  // SQL (its authority/revision reads around the call) failing is never the degradable
  // "embedder failed" closure; only the provider call itself is.
  it.each(["before", "after"] as const)(
    "an SQL failure in the production adapter's own transaction %s the provider call is never the degradable closure",
    async (phase) => {
      const f = await fixture();
      const r = await begin(f);
      const role = (await db.query("runtime", "SELECT current_user AS role")).rows[0]!
        .role as string;
      const columns = (
        await db.query(
          "applier",
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name='provider_revision' AND column_name<>'aadVersion'`,
        )
      ).rows.map((row) => `"${row.column_name as string}"`);
      // Only the adapter reads "aadVersion": its own SQL fails (42501); dispatch does not.
      const breakAdapterSql = async () => {
        await db.query("applier", `REVOKE SELECT ON provider_revision FROM "${role}"`);
        await db.query(
          "applier",
          `GRANT SELECT (${columns.join(",")}) ON provider_revision TO "${role}"`,
        );
      };
      try {
        if (phase === "before") await breakAdapterSql();
        else beforeReply = breakAdapterSql;
        const before = http.requests.length;
        await publish();
        await expect(
          runQueryEmbeddingDelivery(prisma, {
            ...opts,
            durableJobId: r.id,
            workerId: `sql-${phase}`,
          }),
        ).rejects.toThrow();
        expect(http.requests.length - before).toBe(phase === "before" ? 0 : 1);
        expect((await row(r.id)).state).toBe("INDEX_UNAVAILABLE");
        const taken = await takeQueryEmbedding(opts, f.actor, r.id).catch((e: unknown) => e);
        expect(taken).toMatchObject({ code: "INDEX_UNAVAILABLE" });
        // Not degradable: the search fails instead of serving keywords.
        expect(degradableKind(taken)).toBeNull();
      } finally {
        beforeReply = null;
        await db.query("applier", `GRANT SELECT ON provider_revision TO "${role}"`);
      }
    },
  );
  it("an adapter admission timeout while the search budget is live never degrades to keywords", async () => {
    const f = await fixture();
    const held = barrier();
    let holder: Promise<unknown> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    beforeReply = async () => {
      holder = tx(() => held.wait());
      await held.entered;
      // The adapter's five-second admission budget expires before this release;
      // both the query's embedding share and the full search budget remain live.
      releaseTimer = setTimeout(held.release, 5500);
    };
    const lexical = vi.fn(async () => "keywords");
    const pending = withQueryEmbedding(
      opts,
      f.actor,
      { kbId: f.kbId, query: "admission deadline", timeoutMs: 20_000 },
      async () => "hybrid",
      undefined,
      lexical,
    ).catch((error: unknown) => error);
    try {
      const request = await vi.waitFor(async () => {
        const found = await prisma.queryEmbeddingRequest.findFirst({ where: { kbId: f.kbId } });
        expect(found).not.toBeNull();
        return found!;
      });
      await publish();
      await expect(
        runQueryEmbeddingDelivery(prisma, {
          ...opts,
          durableJobId: request.id,
          workerId: key(),
        }),
      ).rejects.toBeDefined();
      expect(await pending).toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(lexical).not.toHaveBeenCalled();
    } finally {
      clearTimeout(releaseTimer);
      held.release();
      beforeReply = null;
      await holder;
      await pending;
    }
  });
  it("rejects default/unusable index and credential-shaped queries without durable enqueue", async () => {
    const f = await fixture(false);
    await expect(begin(f)).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    await expect(
      beginQueryEmbedding(opts, f.actor, {
        kbId: f.kbId,
        query: `Authorization: Bearer ${"x".repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_QUERY" });
    expect(await prisma.queryEmbeddingRequest.count({ where: { kbId: f.kbId } })).toBe(0);
  });
  it("keeps the old generation, fingerprint and head when active switches while paused", async () => {
    const f = await fixture();
    const r = await begin(f);
    const gate = barrier();
    const pending = run(r.id, {
      embed: async (_text, o) => {
        await o.beforeDispatch?.();
        await gate.wait();
        return [[3, 4]];
      },
    });
    try {
      await gate.entered;
      await prisma.knowledgeBase.update({
        where: { id: f.kbId },
        data: { headSha: "b".repeat(40) },
      });
      const newer = await f.build();
      gate.release();
      expect(await pending).toEqual({ accepted: true });
      const result = await takeQueryEmbedding(opts, f.actor, r.id);
      expect(result).toMatchObject({
        generationId: f.generationId,
        vector: [3, 4],
        index: {
          activeGenerationId: f.generationId,
          headSha: "a".repeat(40),
          indexedCommitSha: "a".repeat(40),
        },
      });
      expect(newer).not.toBe(result?.generationId);
      expect((await row(r.id)).resultCiphertext).toBeNull();
      expect((await row(r.id)).queryCiphertext).toBeNull();
      const leaseBefore = await prisma.generationLease.count({ where: { requestId: r.id } });
      await expect(takeQueryEmbedding(opts, f.actor, r.id)).rejects.toMatchObject({
        name: "DurableJobFenceError",
      });
      expect(await prisma.generationLease.count({ where: { requestId: r.id } })).toBe(leaseBefore);
      expect((await row(r.id)).state).toBe("DELIVERED");
    } finally {
      gate.release();
      await pending.catch(() => {});
      await cancelQueryEmbedding(opts, f.actor, r.id);
    }
  });
  for (const phase of ["before", "after"] as const)
    it.each(["cancel", "deadline", "share", "provider", "ban", "model", "transfer"])(
      `%s ${phase} dispatch fences external calls/results and drops private delivery`,
      async (change) => {
        const f = await fixture();
        const r = await begin(f);
        const gate = barrier();
        const sent: string[] = [];
        const pending = run(r.id, {
          embed: async (text, o) => {
            if (phase === "before") await gate.wait();
            await o.beforeDispatch?.();
            sent.push(text[0]!);
            if (phase === "after") await gate.wait();
            return [[3, 4]];
          },
        }).catch((e) => e);
        try {
          await gate.entered;
          if (change === "cancel") await cancelQueryEmbedding(opts, f.actor, r.id);
          if (change === "deadline")
            await prisma.queryEmbeddingRequest.update({
              where: { id: r.id },
              data: { deadline: new Date(0) },
            });
          if (change === "share")
            await tx((q) =>
              q('UPDATE kb_share SET "revokedAt"=now() WHERE "kbId"=$1 AND "userId"=$2', [
                f.kbId,
                f.reader.id,
              ]),
            );
          if (change === "provider")
            await revokeProvider(runtime, f.owner.id, { providerId: f.providerId });
          if (change === "transfer")
            await tx((q) =>
              q('UPDATE knowledge_base SET "ownerId"=$2 WHERE id=$1', [f.kbId, f.reader.id]),
            );
          if (change === "ban")
            await tx((q) => q('UPDATE "user" SET banned=true WHERE id=$1', [f.reader.id]));
          // A kind flip after begin never swaps adapters: the pinned kind/owner must still match.
          if (change === "model")
            await tx((q) =>
              q("UPDATE embedding_provider SET kind='SYSTEM_BUILTIN' WHERE id=$1", [f.providerId]),
            );
          gate.release();
          const workerError = await pending;
          expect(workerError).toMatchObject({
            name: "DurableJobFenceError",
            message: "Query embedding unavailable",
          });
          expect(sent).toHaveLength(phase === "before" ? 0 : 1);
          await expect(takeQueryEmbedding(opts, f.actor, r.id)).rejects.toMatchObject({
            code:
              change === "cancel"
                ? "CANCELLED"
                : change === "deadline"
                  ? "DEADLINE_EXCEEDED"
                  : change === "share"
                    ? "NOT_FOUND"
                    : change === "ban"
                      ? "FORBIDDEN"
                      : "INDEX_UNAVAILABLE",
          });
          expect(await prisma.generationLease.count({ where: { requestId: r.id } })).toBe(0);
          expect(await row(r.id)).toMatchObject({ queryCiphertext: null, resultCiphertext: null });
        } finally {
          gate.release();
          await pending;
        }
      },
    );
  it("uses four query consumers even with both global index permits held; Redis contains IDs only", async () => {
    const f = await fixture();
    const permits = new Client({ connectionString: db.urls.runtime });
    await permits.connect();
    await permits.query("SELECT pg_advisory_lock(1262635337,0),pg_advisory_lock(1262635337,1)");
    const gate = barrier();
    let entered = 0;
    const all = barrier();
    const worker = new Worker(
      "query-embedding",
      (job) =>
        runQueryEmbeddingDelivery(prisma, {
          ...opts,
          durableJobId: job.data.durableJobId,
          workerId: randomUUID(),
          embedder: {
            embed: async (_t, o) => {
              await o.beforeDispatch?.();
              if (++entered === 4) all.release();
              await gate.wait();
              return [[3, 4]];
            },
          },
        }),
      {
        connection: { url: redis.url, maxRetriesPerRequest: null },
        prefix,
        concurrency: 4,
        autorun: false,
      },
    );
    const ids: string[] = [];
    try {
      for (let n = 0; n < 4; n++) ids.push((await begin(f)).id);
      await expect(begin(f)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await publish();
      void worker.run();
      await all.wait();
      expect(entered).toBe(4);
      gate.release();
      await worker.close();
      for (const id of ids) {
        expect((await row(id)).state).toBe("READY");
        const jobs = await queue.getJobs(["completed"], 0, 1000);
        const j = jobs.find((j) => j.data.durableJobId === id)!;
        expect(j.data).toEqual({ durableJobId: id });
        expect(j.returnvalue).toEqual({ accepted: true });
      }
      const jobs = JSON.stringify(await queue.getJobs(["waiting", "completed", "failed"], 0, 1000));
      expect(jobs).not.toContain("private query words");
      expect(jobs).not.toContain("test-only-query-key");
    } finally {
      gate.release();
      await worker.close();
      await permits.end();
      for (const id of ids) await cancelQueryEmbedding(opts, f.actor, id);
    }
  });
  it("Redis recreation and expired-attempt takeover accept only one result and stale writer cannot overwrite", async () => {
    const f = await fixture();
    const r = await begin(f);
    const gate = barrier();
    const old = run(r.id, {
      embed: async (_t, o) => {
        await o.beforeDispatch?.();
        await gate.wait();
        return [[1, 0]];
      },
    }).catch((e) => e);
    try {
      await gate.entered;
      await prisma.durableJob.update({ where: { id: r.id }, data: { leaseUntil: new Date(0) } });
      await claimDispatchBatch(prisma, { owner: "recover", now: new Date() });
      await prisma.durableJob.update({ where: { id: r.id }, data: { nextRunAt: new Date(0) } });
      // Destroy only this suite's Redis namespace; Postgres remains authoritative.
      const keys = await connection.keys(`${prefix}:*`);
      if (keys.length) await connection.del(...keys);
      expect(await run(r.id)).toEqual({ accepted: true });
      const accepted = (await row(r.id)).resultCiphertext;
      gate.release();
      expect(await old).toBeInstanceOf(Error);
      expect((await row(r.id)).resultCiphertext).toBe(accepted);
      expect(await run(r.id)).toEqual({ skipped: true });
      expect((await takeQueryEmbedding(opts, f.actor, r.id))?.vector).toEqual([3, 4]);
    } finally {
      gate.release();
      await old;
      await cancelQueryEmbedding(opts, f.actor, r.id);
    }
  });
  it.each(["42P01", "55P03", "57014"])(
    "a progress peek SQL failure (%s) never becomes an embedding timeout or lexical success",
    async (code) => {
      const f = await fixture();
      const original = Client.prototype.query;
      const queries = vi.spyOn(Client.prototype, "query");
      let failedPeek = false;
      queries.mockImplementation(function (this: Client, ...args) {
        const statement: unknown = args[0];
        if (typeof statement === "string" && statement.startsWith("SELECT r.state,")) {
          failedPeek = true;
          return Promise.reject(Object.assign(new Error("fixture SQL failure"), { code }));
        }
        return Reflect.apply(original, this, args);
      });
      const lexical = vi.fn(async () => "keywords");
      try {
        await expect(
          withQueryEmbedding(
            opts,
            f.actor,
            { kbId: f.kbId, query: "peek failure", timeoutMs: 1500 },
            async () => "hybrid",
            undefined,
            lexical,
          ),
        ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
        expect(failedPeek).toBe(true);
        expect(lexical).not.toHaveBeenCalled();
        expect(
          await prisma.generationLease.count({ where: { generationId: f.generationId! } }),
        ).toBe(0);
      } finally {
        queries.mockRestore();
      }
    },
  );
  it("bounded API timeout/cancel scrubs payload and successful delivery releases after consumption", async () => {
    const f = await fixture();
    await expect(
      withQueryEmbedding(
        opts,
        f.actor,
        { kbId: f.kbId, query: "no consumer", timeoutMs: 150 },
        async () => "unexpected",
      ),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      withQueryEmbedding(
        opts,
        f.actor,
        { kbId: f.kbId, query: "cancelled" },
        async () => "unexpected",
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    const pending = withQueryEmbedding(
      opts,
      f.actor,
      { kbId: f.kbId, query: "delivered", timeoutMs: 5000 },
      async (vector) => {
        expect(
          await prisma.generationLease.count({ where: { generationId: vector.generationId } }),
        ).toBe(1);
        return vector.generationId;
      },
    );
    let request: Awaited<ReturnType<typeof row>> | null = null;
    for (let i = 0; i < 100; i++) {
      request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      if (request) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(request).toBeTruthy();
    await run(request!.id);
    expect(await pending).toBe(f.generationId);
    expect(await prisma.generationLease.count({ where: { generationId: f.generationId! } })).toBe(
      0,
    );
    expect(await row(request!.id)).toMatchObject({
      state: "DELIVERED",
      queryCiphertext: null,
      resultCiphertext: null,
    });
    const next = await begin(f);
    await cancelQueryEmbedding(opts, f.actor, next.id);
  });
  it("R3-L4: a query embedding waits at most its bound; the timeout opens the target's breaker", {
    timeout: 60_000,
  }, async () => {
    const f = await fixture();
    // No worker delivers: the embedding times out after its own bound, not the 50 s share.
    const started = Date.now();
    await expect(
      withQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: "stalled" }, async () => "no"),
    ).rejects.toMatchObject({ fallback: "EMBEDDING_FAILED" });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(QUERY_EMBEDDING_DEADLINE_MS - 100);
    expect(waited).toBeLessThan(QUERY_EMBEDDING_DEADLINE_MS + 5_000);
    // Open: the next search is lexical at once and enqueues nothing.
    const requests = await prisma.queryEmbeddingRequest.count({ where: { kbId: f.kbId } });
    const again = Date.now();
    await expect(
      withQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: "again" }, async () => "no"),
    ).rejects.toMatchObject({ fallback: "EMBEDDING_FAILED" });
    expect(Date.now() - again).toBeLessThan(2_000);
    expect(await prisma.queryEmbeddingRequest.count({ where: { kbId: f.kbId } })).toBe(requests);
    // The breaker belongs to the target (provider revision), not the user: another user of the
    // same stalled provider is served keywords at once too.
    const owner = { principal: { kind: "browser" as const, userId: f.owner.id } };
    const otherAt = Date.now();
    await expect(
      withQueryEmbedding(opts, owner, { kbId: f.kbId, query: "other user" }, async () => "no"),
    ).rejects.toMatchObject({ fallback: "EMBEDDING_FAILED" });
    expect(Date.now() - otherAt).toBeLessThan(2_000);
  });
  it("R3-L4: the bound starts after admission; slow admission never opens the breaker for anyone", {
    timeout: 60_000,
  }, async () => {
    const f = await fixture();
    // Admission (authority, SQL, rate limit) takes longer than the whole embedding bound.
    const slow: typeof opts.ratePort = {
      counts: opts.ratePort.counts,
      consume: async (...args) => {
        await new Promise((r) => setTimeout(r, QUERY_EMBEDDING_DEADLINE_MS + 500));
        return opts.ratePort.consume(...args);
      },
    };
    const pending = withQueryEmbedding(
      { ...opts, ratePort: slow },
      f.actor,
      { kbId: f.kbId, query: "slow admission" },
      async (vector) => vector.generationId,
    ).catch((error: unknown) => error);
    const request = await vi.waitFor(
      async () => {
        const found = await prisma.queryEmbeddingRequest.findFirst({
          where: { kbId: f.kbId, state: "PENDING" },
        });
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: QUERY_EMBEDDING_DEADLINE_MS + 5_000 },
    );
    await run(request.id);
    // Hybrid: the embedding got its full bound after admission.
    expect(await pending).toBe(f.generationId);
    // Another user of the same target is unaffected: still hybrid.
    const owner = { principal: { kind: "browser" as const, userId: f.owner.id } };
    const other = withQueryEmbedding(
      opts,
      owner,
      { kbId: f.kbId, query: "other user" },
      async (vector) => vector.generationId,
    ).catch((error: unknown) => error);
    const second = await vi.waitFor(async () => {
      const found = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      expect(found).not.toBeNull();
      return found!;
    });
    await run(second.id);
    expect(await other).toBe(f.generationId);
  });
  it("persisted lease and scrub deadlines bound abandoned requests without a live API process", async () => {
    const f = await fixture();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { beginQueryEmbedding } from './packages/api/src/lib/kb/query-embedding.ts';
      import { createMemoryRatePort } from './packages/api/src/lib/kb/limits.ts';
      process.on('message', async ({options,actor,kbId}) => {
        try { const request=await beginQueryEmbedding({...options,ratePort:createMemoryRatePort()},actor,{kbId,query:'abandoned'});process.send({id:request.id}); }
        catch {process.send({error:true});}
      });`,
      ],
      {
        cwd: new URL("../../../../", import.meta.url),
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let r: { id: string };
    try {
      const received = once(child, "message");
      child.send({
        options: { connectionString: opts.connectionString, masterKey: opts.masterKey },
        actor: f.actor,
        kbId: f.kbId,
      });
      const [message] = await received;
      expect(message).toHaveProperty("id");
      r = message;
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    const request = await row(r.id);
    const lease = await prisma.generationLease.findUniqueOrThrow({ where: { requestId: r.id } });
    expect(lease.expiresAt.getTime() - request.createdAt.getTime()).toBe(90_000);
    expect(request.scrubAt.getTime() - request.createdAt.getTime()).toBe(300_000);
    await prisma.generationLease.update({
      where: { requestId: r.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(takeQueryEmbedding(opts, f.actor, r.id)).rejects.toMatchObject({
      code: "INDEX_UNAVAILABLE",
    });
    expect(await prisma.generationLease.count({ where: { requestId: r.id } })).toBe(0);
  });
  it("final recheck prevents a private callback result after share revocation", async () => {
    const f = await fixture();
    const pending = withQueryEmbedding(
      opts,
      f.actor,
      { kbId: f.kbId, query: "final boundary", timeoutMs: 5000 },
      async () => {
        await tx((q) =>
          q('UPDATE kb_share SET "revokedAt"=now() WHERE "kbId"=$1 AND "userId"=$2', [
            f.kbId,
            f.reader.id,
          ]),
        );
        return "private";
      },
    ).catch((e) => e);
    let r: Awaited<ReturnType<typeof row>> | null = null;
    for (let n = 0; n < 100; n++) {
      r = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      if (r) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await run(r!.id);
    expect(await pending).toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.generationLease.count({ where: { requestId: r!.id } })).toBe(0);
  });
  it("tokens without live verifier and mismatched actors cannot dispatch or take a request", async () => {
    const f = await fixture();
    const r = await begin(f);
    await expect(
      takeQueryEmbedding(opts, { principal: { kind: "browser", userId: f.owner.id } }, r.id),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    expect((await row(r.id)).state).toBe("PENDING");
    await prisma.queryEmbeddingRequest.update({
      where: { id: r.id },
      data: {
        actorKey: "grant:fixture",
        principal: {
          kind: "token",
          userId: f.reader.id,
          grantId: "fixture",
          grantGeneration: randomUUID(),
          scopes: ["mcp:read"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          storedAcl: [[f.kbId, ["read"]]],
          toolGroupDemands: [["read"]],
        },
      },
    });
    await publish();
    await prisma.durableJob.update({
      where: { id: r.id },
      data: { state: "RUNNING", workerOwner: "token", leaseUntil: new Date(Date.now() + 30_000) },
    });
    await expect(
      dispatchQueryEmbedding(opts, { jobId: r.id, workerId: "token", epoch: 1 }),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
  });
});

describe("R30 F5 durable PAT admission", () => {
  it.each(["null", "dated", "expired", "revoked"])(
    "worker restores %s expiry/generation correctly",
    async (mode) => {
      const f = await fixture();
      const minted = await mintPersonalToken(runtime, f.reader.id, {
        name: "query",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: f.kbId, bits: ["read"] }],
        expiresAt: mode === "null" ? null : new Date(Date.now() + 3600_000),
      });
      const q = prismaAssetQuery(prisma);
      const principal = await authenticatePersonalToken(q, minted.secret, new Date());
      if (!principal) throw new Error("fixture PAT not identified");
      const options = { ...opts, verifier: createGrantCredentialVerifier(q) };
      const actor = { principal, verifier: options.verifier };
      const pending = await beginQueryEmbedding(options, actor, { kbId: f.kbId, query: "query" });
      expect((await row(pending.id)).principal).toMatchObject({
        expiresAt: mode === "null" ? null : principal.expiresAt!.toISOString(),
        credential: principal.credential,
      });
      if (mode === "expired")
        await prisma.mcpPersonalToken.update({
          where: { id: minted.token.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      if (mode === "revoked") await revokeGrant(runtime, f.reader.id, principal.grantId);
      await publish();
      const before = http.requests.length;
      const delivery = () =>
        runQueryEmbeddingDelivery(prisma, {
          ...opts,
          durableJobId: pending.id,
          workerId: randomUUID(),
        });
      if (mode === "null" || mode === "dated") {
        await expect(delivery()).resolves.toEqual({ accepted: true });
        expect(http.requests.length).toBe(before + 1);
        expect((await row(pending.id)).state).toBe("READY");
        expect((await takeQueryEmbedding(options, actor, pending.id))?.vector).toEqual([3, 4]);
        await cancelQueryEmbedding(options, actor, pending.id);
      } else {
        await expect(delivery()).rejects.toThrow();
        expect(http.requests.length).toBe(before);
        expect((await row(pending.id)).state).toBe("INDEX_UNAVAILABLE");
      }
    },
  );
});
