// @ts-nocheck — PG integration harness.
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
/**
 * Retention suite (`pnpm test:kb -- retention`). Real PostgreSQL:
 * fake clocks move only the retention cutoffs; lease liveness is always the
 * database clock, so a fake `now` can never make a live lease look expired.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { opendir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapExpiredAuthTokens } from "@knowledge-base/api/lib/auth-token-retention";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import {
  activateIndexBuild,
  indexBuildSnapshotSchema,
  requestIndexBuild,
} from "@knowledge-base/api/lib/kb/generations";
import { buildTestIndex } from "@knowledge-base/api/lib/kb/index-file/testing";
import { getIndexProfile } from "@knowledge-base/api/lib/kb/index-status";
import { createMemoryRatePort, KB_LIMITS } from "@knowledge-base/api/lib/kb/limits";
import {
  findOperationIntent,
  recordFinalizedReceipt,
  replayFinalizedIntent,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { sqlAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { indexStatusSchema } from "@knowledge-base/api/lib/kb/protocol/common";
import { createProvider } from "@knowledge-base/api/lib/kb/providers";
import {
  beginQueryEmbedding,
  cancelQueryEmbedding,
  takeQueryEmbedding,
} from "@knowledge-base/api/lib/kb/query-embedding";
import { reserveQuota, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import {
  compactOperationReceipts,
  deleteExpiredAuditEvents,
  INDEX_RECONCILE_ENTRIES,
  listAuditEventsForExport,
  markExpiredStagedUploads,
  purgeRetiredGenerations,
  RETENTION,
  reconcileIndexFiles,
  releaseStaleBuildReservations,
  resetIndexReconcilerForTests,
  runKbRetention,
  scrubExpiredQueryData,
} from "@knowledge-base/api/lib/kb/retention";
import { stagedUploadPath, sweepExpiredStagedUploads } from "@knowledge-base/api/lib/kb/uploads";
import { captureLog } from "@knowledge-base/env/log";
import { Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initKbVolumes } from "../../../../scripts/init-kb-volumes.mjs";
import { startPublicHttpFixture } from "./http-fixture";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

const { runQueryEmbeddingDelivery } = await import(
  new URL("../../../../apps/worker/src/handlers/query-embedding.ts", import.meta.url).href
);

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: wire.request }));
const http = await startPublicHttpFixture({
  handler: (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }));
  },
});
wire.request.mockImplementation((url: URL, options: RequestOptions) => {
  if (url.hostname !== "provider.example.invalid") throw new Error("Unexpected fixture host");
  return httpRequest(`${http.origin}${url.pathname}`, { ...options, lookup: undefined });
});

const DAY = 86_400_000;
const PROVIDER_KEY_CANARY = "sk-retentioncanary-provider-key-000000000000";
const QUERY_CANARY = "retentioncanaryquery words";
const SOURCE_CANARY = "retentioncanarysource body";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
const redis = openKbRedisFromEnv();
const connection = redis.client();
const prefix = redis.key("bull");
const queue = new Queue("query-embedding", { connection, prefix });
const dataRoot = mkdtempSync(join(tmpdir(), "kb-retention-data-"));
const { assetsDir } = initKbVolumes({ KB_DATA_ROOT: dataRoot });
const opts = {
  connectionString: db.urls.runtime,
  masterKey: Buffer.alloc(32, 47).toString("base64"),
  ratePort: createMemoryRatePort(),
};
const indexDir = join(dataRoot, "index");
const retention = { connectionString: db.urls.runtime, indexDir };
const id = () => `r${randomUUID().replaceAll("-", "").slice(0, 23)}`;
const key = () => randomUUID().replaceAll("-", "");
const tx = <T>(run: (q) => Promise<T>) =>
  runLockedOperation({
    connectionString: db.urls.runtime,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) => lease.transaction(run),
  });
const runtime = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir: "/unused",
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
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
async function sql(text: string, params: unknown[] = []) {
  const c = new Client({ connectionString: db.urls.runtime });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}
/** One KB whose generations each hold one INDEXED document with one chunk (vector + FTS row). */
async function fixture() {
  const owner = await user();
  const reader = await user();
  const kbId = id();
  await prisma.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: owner.id,
      name: "Retention",
      slug: id(),
      description: "Retention fixture KB",
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
      apiKey: PROVIDER_KEY_CANARY,
      idempotencyKey: key(),
    },
    opts.masterKey,
  );
  await prisma.durableJob.update({ where: { id: created.jobId }, data: { state: "COMPLETE" } });
  const actor = { principal: { kind: "browser" as const, userId: reader.id } };
  let attached = false;
  /** Stops at `stopAt` ("BUILDING" for a build that will fail) or activates. */
  const build = async (stopAt?: "BUILDING") => {
    // Attach the profile once; re-attaching the serving profile starts nothing
    // (R3-L12), so every later build is an explicit rebuild.
    const b = await requestIndexBuild(
      runtime,
      { principal: { kind: "browser", userId: owner.id } },
      {
        kbId,
        ...(attached ? {} : { providerId: created.provider.providerId, revision: 1 }),
        confirm: "RUN",
        idempotencyKey: key(),
      },
    );
    attached = true;
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
    if (stopAt === "BUILDING") return { generationId: b.generationId, jobId: b.jobId };
    await sql(
      `INSERT INTO generation_document ("generationId",path,"blobSha","contentHash","originalWindowCount","retainedWindowCount",state)
       VALUES ($1,'doc.md',$2,$3,1,1,'INDEXED')`,
      [b.generationId, "b".repeat(40), `sha256:${"c".repeat(64)}`],
    );
    const g = await prisma.indexGeneration.findUniqueOrThrow({ where: { id: b.generationId } });
    await buildTestIndex({
      indexDir,
      kbId,
      generationId: b.generationId,
      commitSha: g.commitSha,
      fingerprint: g.fingerprint,
      dimensions: 2,
      documents: [{ path: "doc.md", chunks: [SOURCE_CANARY] }],
    });
    await prisma.indexGeneration.update({
      where: { id: b.generationId },
      data: { documentCount: 1, chunkCount: 1 },
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
    return { generationId: b.generationId, jobId: b.jobId };
  };
  const first = await build();
  return { owner, reader, kbId, actor, providerId: created.provider.providerId, first, build };
}
/** Every file name of a generation in its KB directory (final, temps, journals). */
function filesOf(kbId: string, generationId: string) {
  const dir = join(indexDir, kbId);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(generationId)) : [];
}
async function rows(generationId: string) {
  const docs = await sql(
    'SELECT count(*)::int AS n FROM generation_document WHERE "generationId"=$1',
    [generationId],
  );
  const g = await prisma.indexGeneration.findUniqueOrThrow({ where: { id: generationId } });
  return {
    state: g.state,
    files: filesOf(g.kbId, generationId).length,
    documents: docs.rows[0].n,
  };
}
async function publish() {
  await runDurableDispatcherCycle({
    db: prisma,
    ownerId: "retention-test",
    now: () => new Date(),
    getQueue: () => queue,
  });
}
async function deliver(requestId: string) {
  await publish();
  return runQueryEmbeddingDelivery(prisma, {
    ...opts,
    durableJobId: requestId,
    workerId: randomUUID(),
    embedder: {
      embed: async (_texts, o) => {
        await o.beforeDispatch?.();
        return [[3, 4]];
      },
    },
  });
}
const later = (ms: number) => new Date(Date.now() + ms);

afterAll(async () => {
  await http.close();
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("generation retention never outruns a query lease (regression)", () => {
  it("keeps a leased superseded generation's chunks/documents/FTS until the lease ends, then removes them", async () => {
    const f = await fixture();
    const a = f.first.generationId;
    const r = await beginQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: QUERY_CANARY });
    expect(r.generationId).toBe(a);
    expect(await deliver(r.id)).toEqual({ accepted: true });
    await f.build(); // B activates; A becomes SUPERSEDED while its lease is live.
    expect((await rows(a)).state).toBe("SUPERSEDED");

    // Far beyond every TTL: only the live lease protects A.
    const first = await purgeRetiredGenerations({ ...retention, now: later(400 * DAY) });
    expect(first.purged).toBe(0);
    expect(await rows(a)).toEqual({ state: "SUPERSEDED", files: 1, documents: 1 });
    // The DB guard itself refuses a direct delete while the lease is live.
    await expect(
      sql('DELETE FROM generation_document WHERE "generationId"=$1', [a]),
    ).rejects.toMatchObject({ code: "23514" });

    // The leased query can still read A's file.
    const vector = await takeQueryEmbedding(opts, f.actor, r.id);
    expect(vector?.generationId).toBe(a);
    expect(filesOf(f.kbId, a)).toEqual([`${a}.sqlite`]);

    // Release the lease: the next sweep removes A completely.
    await cancelQueryEmbedding(opts, f.actor, r.id);
    const second = await purgeRetiredGenerations({ ...retention, now: later(400 * DAY) });
    expect(second.purged).toBe(1);
    // The file is unlinked only after the PURGED row committed.
    expect(await rows(a)).toEqual({ state: "PURGED", files: 0, documents: 0 });
    // A purged generation can never be leased again.
    await expect(
      beginQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: "after purge" }),
    ).resolves.toMatchObject({ generationId: expect.not.stringMatching(a) });
    await expect(
      sql(
        `INSERT INTO generation_lease ("requestId","generationId","expiresAt") SELECT id,$2,now()+interval '1 minute' FROM query_embedding_request WHERE "kbId"=$1 LIMIT 1`,
        [f.kbId, a],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("an expired lease no longer protects; a lease taken between scan and lock does (transactional recheck)", async () => {
    const f = await fixture();
    const a = f.first.generationId;
    const r = await beginQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: "expiring lease" });
    await f.build();
    const racing = await beginQueryEmbedding(opts, f.actor, { kbId: f.kbId, query: "racer" });
    await sql(
      `UPDATE generation_lease SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "requestId"=$1`,
      [r.id],
    );
    // A live lease on A appears after the candidate scan, before the per-generation lock.
    const raced = await purgeRetiredGenerations({
      ...retention,
      now: later(8 * DAY),
      beforeRow: async (generationId) => {
        if (generationId === a)
          await sql(`UPDATE generation_lease SET "generationId"=$2 WHERE "requestId"=$1`, [
            racing.id,
            a,
          ]);
      },
    });
    expect(raced.purged).toBe(0);
    expect(await rows(a)).toMatchObject({ state: "SUPERSEDED", files: 1, documents: 1 });
    // Expire every lease on A: the next sweep purges it.
    await sql(
      `UPDATE generation_lease SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "generationId"=$1`,
      [a],
    );
    expect((await purgeRetiredGenerations({ ...retention, now: later(8 * DAY) })).purged).toBe(1);
    expect((await rows(a)).state).toBe("PURGED");
    await cancelQueryEmbedding(opts, f.actor, racing.id);
    await cancelQueryEmbedding(opts, f.actor, r.id);
  });
});

describe("generation TTLs", () => {
  it("superseded 7d, failed builds 24h after the final attempt; active/building never", async () => {
    const f = await fixture();
    const a = f.first.generationId;
    const b = (await f.build()).generationId;
    const retiredAt = (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a } }))
      .retiredAt;
    expect(retiredAt).toBeInstanceOf(Date);
    await purgeRetiredGenerations({
      ...retention,
      now: new Date(retiredAt.getTime() + RETENTION.supersededGenerationMs - 1000),
    });
    expect((await rows(a)).state).toBe("SUPERSEDED");
    await purgeRetiredGenerations({
      ...retention,
      now: new Date(retiredAt.getTime() + RETENTION.supersededGenerationMs + 1000),
    });
    expect(await rows(a)).toMatchObject({ state: "PURGED", files: 0, documents: 0 });

    // A failed build still owned by a retrying job is not final. (A second KB: the
    // rebuild budget is 3/hour/KB.)
    const g = await fixture();
    const c = await g.build("BUILDING");
    await prisma.indexGeneration.update({
      where: { id: c.generationId },
      data: { state: "FAILED" },
    });
    await prisma.durableJob.update({ where: { id: c.jobId }, data: { state: "RETRY" } });
    await purgeRetiredGenerations({ ...retention, now: later(30 * DAY) });
    expect((await rows(c.generationId)).state).toBe("FAILED");
    await prisma.durableJob.update({ where: { id: c.jobId }, data: { state: "FAILED" } });
    const failedAt = (
      await prisma.indexGeneration.findUniqueOrThrow({ where: { id: c.generationId } })
    ).retiredAt;
    await purgeRetiredGenerations({
      ...retention,
      now: new Date(failedAt.getTime() + RETENTION.failedBuildMs - 1000),
    });
    expect((await rows(c.generationId)).state).toBe("FAILED");
    await purgeRetiredGenerations({
      ...retention,
      now: new Date(failedAt.getTime() + RETENTION.failedBuildMs + 1000),
    });
    expect((await rows(c.generationId)).state).toBe("PURGED");
    const profile = await getIndexProfile(
      runtime,
      { principal: { kind: "browser", userId: g.owner.id } },
      g.kbId,
    );
    expect(profile.index).toMatchObject({ desiredState: "FAILED", freshness: "failed" });
    expect(indexStatusSchema.safeParse(profile.index).success).toBe(true);
    expect(profile.index.desiredGenerationId).toBe(c.generationId);

    // Active B and a BUILDING generation survive any clock.
    const d = await g.build("BUILDING");
    await purgeRetiredGenerations({ ...retention, now: later(3650 * DAY) });
    expect(await rows(b)).toMatchObject({ state: "COMPLETE", files: 1 });
    expect((await rows(d.generationId)).state).toBe("BUILDING");
  });

  it("a purge whose file cleanup fails stays committed; the reconciler removes the files", async () => {
    const f = await fixture();
    const a = f.first.generationId;
    await f.build();
    const kbDir = join(indexDir, f.kbId);
    expect(filesOf(f.kbId, a)).toEqual([`${a}.sqlite`]);
    // Unlinking in the KB's index directory fails after the PURGED row commits.
    chmodSync(kbDir, 0o500);
    const log = captureLog();
    try {
      expect((await purgeRetiredGenerations({ ...retention, now: later(8 * DAY) })).purged).toBe(1);
      expect(log.records.filter((r) => r.site.startsWith("kb.retention-"))).toEqual([
        expect.objectContaining({
          site: "kb.retention-cleanup",
          sweep: "retired-generations",
          rowId: a,
        }),
      ]);
    } finally {
      log.restore();
      chmodSync(kbDir, 0o700);
    }
    // The row is final and never selected again; its files are the reconciler's.
    expect((await rows(a)).state).toBe("PURGED");
    expect(filesOf(f.kbId, a)).toEqual([`${a}.sqlite`]);
    expect((await purgeRetiredGenerations({ ...retention, now: later(8 * DAY) })).purged).toBe(0);
    expect((await reconcileIndexFiles(retention)).removed).toBeGreaterThanOrEqual(1);
    expect(filesOf(f.kbId, a)).toEqual([]);
  });

  it("the active pointer is re-checked under the row lock and enforced by the DB guard", async () => {
    const f = await fixture();
    const a = f.first.generationId;
    // Guard: the active generation can never be purged or have rows deleted.
    await expect(
      sql(`UPDATE index_generation SET state='PURGED' WHERE id=$1`, [a]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql('DELETE FROM generation_document WHERE "generationId"=$1', [a]),
    ).rejects.toMatchObject({ code: "23514" });
    const result = await purgeRetiredGenerations({ ...retention, now: later(3650 * DAY) });
    expect(result.purged).toBe(0);
    expect(await rows(a)).toMatchObject({ state: "COMPLETE", files: 1 });
  });
});

describe("index files and build reservations (P4)", () => {
  const HOUR_AGO = (Date.now() - 3_600_000) / 1000;
  const touch = (kbId: string, name: string, old = true) => {
    mkdirSync(join(indexDir, kbId), { recursive: true });
    const path = join(indexDir, kbId, name);
    writeFileSync(path, "x");
    if (old) utimesSync(path, HOUR_AGO, HOUR_AGO);
    return path;
  };
  async function reserveFor(generationId: string, bytes = 4096) {
    mkdirSync(indexDir, { recursive: true });
    return tx(async (q) => {
      const lease = await reserveQuota(
        { transactionQuery: q },
        {
          opId: `index-build:${generationId}:test:${randomUUID()}`,
          charges: [],
          disks: [{ path: indexDir, bytes: BigInt(bytes), meter: statfsDiskMeter(indexDir) }],
          expiresAt: later(DAY),
        },
      );
      await q(
        `UPDATE index_generation SET "quotaReservationIds"="quotaReservationIds" || $2::text[] WHERE id=$1`,
        [generationId, lease.reservationIds],
      );
      return lease.reservationIds;
    });
  }
  const reserved = async () =>
    (
      await sql(
        `SELECT COALESCE(sum(reserved),0)::text AS n FROM quota_account WHERE dimension='DISK_VOLUME'`,
      )
    ).rows[0].n;
  const outcomes = async (ids: string[]) =>
    (
      await sql(`SELECT outcome::text AS o FROM quota_reservation WHERE id = ANY($1::text[])`, [
        ids,
      ])
    ).rows.map((row) => row.o);
  const idsOf = async (generationId: string) =>
    (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: generationId } }))
      .quotaReservationIds;

  it("backstop: releases and clears a BUILDING generation whose job is no longer live", async () => {
    const f = await fixture();
    const c = await f.build("BUILDING");
    const before = await reserved();
    const ids = await reserveFor(c.generationId);
    expect(await reserved()).not.toBe(before);
    // A live job keeps its reservations.
    expect(await releaseStaleBuildReservations(retention)).toBe(0);
    expect(await idsOf(c.generationId)).toEqual(ids);
    // Dispatcher recovery exhausted the attempt (worker killed holding ids).
    await prisma.durableJob.update({ where: { id: c.jobId }, data: { state: "FAILED" } });
    expect(await releaseStaleBuildReservations(retention)).toBe(1);
    expect(await idsOf(c.generationId)).toEqual([]);
    // Settled with its job (one liveness rule): no longer an unfinished build.
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: c.generationId } })).state,
    ).toBe("FAILED");
    expect(await outcomes(ids)).toEqual(["RELEASED"]);
    expect(await reserved()).toBe(before);
    expect(await releaseStaleBuildReservations(retention)).toBe(0);
  });

  it("backstop: clears stale released ids of a cancelled job without touching the ledger", async () => {
    const f = await fixture();
    const c = await f.build("BUILDING");
    const ids = await reserveFor(c.generationId);
    await tx((q) =>
      q(
        `UPDATE quota_reservation SET outcome='RELEASED',"releasedAt"=now() WHERE id = ANY($1::text[])`,
        [ids],
      ),
    );
    await sql(
      `UPDATE quota_account a SET reserved = reserved - 4096 WHERE a.id = (SELECT "accountId" FROM quota_reservation WHERE id=$1)`,
      [ids[0]],
    );
    const before = await reserved();
    await prisma.durableJob.update({ where: { id: c.jobId }, data: { state: "CANCELLED" } });
    expect(await releaseStaleBuildReservations(retention)).toBe(1);
    expect(await idsOf(c.generationId)).toEqual([]);
    expect(await reserved()).toBe(before);
  });

  it("backstop: skips a row whose generation fence is held, processes the rest, clears it next run", async () => {
    const f = await fixture();
    const held = await f.build("BUILDING");
    const g = await fixture();
    const free = await g.build("BUILDING");
    const heldIds = await reserveFor(held.generationId);
    await reserveFor(free.generationId);
    await prisma.durableJob.update({ where: { id: held.jobId }, data: { state: "FAILED" } });
    await prisma.durableJob.update({ where: { id: free.jobId }, data: { state: "FAILED" } });
    const fence = new Client({ connectionString: db.urls.runtime });
    await fence.connect();
    try {
      await fence.query("BEGIN");
      await fence.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 23))", [
        held.generationId,
      ]);
      expect(await releaseStaleBuildReservations(retention)).toBe(1);
      expect(await idsOf(held.generationId)).toEqual(heldIds);
      expect(await idsOf(free.generationId)).toEqual([]);
    } finally {
      await fence.query("ROLLBACK").catch(() => {});
      await fence.end();
    }
    expect(await releaseStaleBuildReservations(retention)).toBe(1);
    expect(await idsOf(held.generationId)).toEqual([]);
    expect(await outcomes(heldIds)).toEqual(["RELEASED"]);
  });

  it("backstop: a row whose release fails never stops the rest; it settles on the next run", async () => {
    const f = await fixture();
    const g = await fixture();
    const [broken, free] = [await f.build("BUILDING"), await g.build("BUILDING")].sort((x, y) =>
      x.generationId < y.generationId ? -1 : 1,
    );
    // The failing row is visited first, so a throw-through would leave `free` unsettled.
    const brokenIds = await reserveFor(broken!.generationId);
    const freeIds = await reserveFor(free!.generationId);
    await prisma.durableJob.update({ where: { id: broken!.jobId }, data: { state: "FAILED" } });
    await prisma.durableJob.update({ where: { id: free!.jobId }, data: { state: "FAILED" } });
    // Inconsistent accounting: the volume account holds less than this reservation.
    await sql("UPDATE quota_reservation SET amount = 9000000000000000 WHERE id = $1", [
      brokenIds[0],
    ]);
    const log = captureLog();
    try {
      expect(await releaseStaleBuildReservations(retention)).toBe(1);
      expect(log.records).toContainEqual(
        expect.objectContaining({
          site: "kb.retention-row",
          sweep: "stale-build-reservations",
          rowId: broken!.generationId,
          errorCode: "STORAGE_UNAVAILABLE",
        }),
      );
    } finally {
      log.restore();
    }
    expect(await idsOf(free!.generationId)).toEqual([]);
    expect(await outcomes(freeIds)).toEqual(["RELEASED"]);
    // The failed row rolled back alone and is retried.
    expect(await idsOf(broken!.generationId)).toEqual(brokenIds);
    expect(await outcomes(brokenIds)).toEqual(["RESERVED"]);
    await sql("UPDATE quota_reservation SET amount = 4096 WHERE id = $1", [brokenIds[0]]);
    expect(await releaseStaleBuildReservations(retention)).toBe(1);
    expect(await idsOf(broken!.generationId)).toEqual([]);
    expect(await outcomes(brokenIds)).toEqual(["RELEASED"]);
  });

  it("reconciler: unlinks stale temps and journals, keeps running and fresh temps and every directory", async () => {
    resetIndexReconcilerForTests();
    const f = await fixture();
    const running = await f.build("BUILDING");
    const cancelled = await f.build("BUILDING");
    await prisma.durableJob.update({
      where: { id: running.jobId },
      data: { attemptEpoch: 1 },
    });
    await prisma.durableJob.update({
      where: { id: cancelled.jobId },
      data: { state: "CANCELLED" },
    });
    const keep = [
      touch(f.kbId, `${running.generationId}.a1.tmp`),
      touch(f.kbId, `${running.generationId}.a1.tmp-journal`),
      touch(f.kbId, `${cancelled.generationId}.a2.tmp`, false),
      touch(f.kbId, "notes.txt"),
      touch(f.kbId, `${f.first.generationId}.sqlite-wal`),
    ];
    const gone = [
      touch(f.kbId, `${cancelled.generationId}.a1.tmp`),
      touch(f.kbId, `${cancelled.generationId}.a1.tmp-journal`),
      touch(f.kbId, `${running.generationId}.a0x.tmp`),
    ];
    // The malformed name above is unknown, so it must be kept as well.
    keep.push(gone.pop()!);
    const warn = captureLog();
    try {
      expect((await reconcileIndexFiles(retention)).removed).toBe(2);
    } finally {
      warn.restore();
    }
    for (const path of keep) expect(existsSync(path)).toBe(true);
    for (const path of gone) expect(existsSync(path)).toBe(false);
    // COMPLETE finals belong to retention, never to the reconciler.
    expect(existsSync(join(indexDir, f.kbId, `${f.first.generationId}.sqlite`))).toBe(true);
    expect(existsSync(join(indexDir, f.kbId))).toBe(true);
    expect(INDEX_RECONCILE_ENTRIES).toBe(1000);
  });

  it("reconciler: unlinks orphaned BUILDING/INDEXING finals and absent generations, keeps live ones", async () => {
    resetIndexReconcilerForTests();
    const f = await fixture();
    // Crash after link before COMMIT, then cancel: a BUILDING final.
    const crashed = await f.build("BUILDING");
    await prisma.durableJob.update({ where: { id: crashed.jobId }, data: { state: "CANCELLED" } });
    // Cancel between publish and activation: an INDEXING final. (Fresh KBs: the rebuild
    // budget is 3/hour/KB.)
    const g = await fixture();
    const cancelled = await g.build("BUILDING");
    await prisma.indexGeneration.update({
      where: { id: cancelled.generationId },
      data: { state: "INDEXING" },
    });
    await prisma.durableJob.update({
      where: { id: cancelled.jobId },
      data: { state: "CANCELLED" },
    });
    // A live INDEXING final (job still RUNNING) is kept.
    const h = await fixture();
    const live = await h.build("BUILDING");
    await prisma.indexGeneration.update({
      where: { id: live.generationId },
      data: { state: "INDEXING" },
    });
    const crashedFinal = touch(f.kbId, `${crashed.generationId}.sqlite`, false);
    const cancelledFinal = touch(g.kbId, `${cancelled.generationId}.sqlite`, false);
    const liveFinal = touch(h.kbId, `${live.generationId}.sqlite`, false);
    const foreign = touch(f.kbId, `${id()}.sqlite`, false);
    // Within the grace only the absent generation's final goes (counts include other suites' files).
    expect((await reconcileIndexFiles(retention)).removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(foreign)).toBe(false);
    expect(existsSync(crashedFinal)).toBe(true);
    resetIndexReconcilerForTests();
    expect(
      (await reconcileIndexFiles({ ...retention, indexTempGraceMs: 0 })).removed,
    ).toBeGreaterThanOrEqual(2);
    expect(existsSync(crashedFinal)).toBe(false);
    expect(existsSync(cancelledFinal)).toBe(false);
    expect(existsSync(liveFinal)).toBe(true);
  });

  it("reconciler: charges every entry and resumes inside a directory, so an orphan behind 1,000 kept entries is reached", async () => {
    resetIndexReconcilerForTests();
    const f = await fixture();
    const cancelled = await f.build("BUILDING");
    await prisma.durableJob.update({
      where: { id: cancelled.jobId },
      data: { state: "CANCELLED" },
    });
    // 1,100 kept entries that sort before the orphan (generation ids start with "g").
    for (let i = 0; i < 1100; i++) touch(f.kbId, `0keep-${String(i).padStart(4, "0")}`, false);
    const orphan = touch(f.kbId, `${cancelled.generationId}.a1.tmp`);
    const warn = captureLog();
    const charged: number[] = [];
    // Count the dirents actually consumed, per pass, through the opener seam.
    let consumed = 0;
    const counting = {
      ...retention,
      openIndexDir: async (path: string) => {
        const dir = await opendir(path);
        return {
          close: () => dir.close(),
          async *[Symbol.asyncIterator]() {
            for await (const entry of dir) {
              consumed += 1;
              yield entry;
            }
          },
        };
      },
    };
    const reads: number[] = [];
    try {
      for (let pass = 0; pass < 20 && existsSync(orphan); pass++) {
        consumed = 0;
        const result = await reconcileIndexFiles(counting);
        charged.push(result.examined);
        reads.push(consumed);
        expect(result.direntsRead).toBe(consumed);
        // Dirents read are bounded by the per-directory cap times the directories visited.
        expect(consumed).toBeLessThanOrEqual(KB_LIMITS.indexDirEntryCap * result.examined);
      }
    } finally {
      warn.restore();
    }
    expect(existsSync(orphan)).toBe(false);
    // No pass ever judges more than the budget, and the budget was actually reached.
    expect(Math.max(...charged)).toBe(INDEX_RECONCILE_ENTRIES);
    expect(charged.every((n) => n <= INDEX_RECONCILE_ENTRIES)).toBe(true);
    expect(reads.length).toBeGreaterThan(1);
    expect(
      readdirSync(join(indexDir, f.kbId)).filter((name) => name.startsWith("0keep-")),
    ).toHaveLength(1100);
    for (let i = 0; i < 1100; i++)
      rmSync(join(indexDir, f.kbId, `0keep-${String(i).padStart(4, "0")}`), { force: true });
  });

  it("reconciler: a directory over its dirent cap is skipped with a redacted warning after at most cap+1 reads", async () => {
    resetIndexReconcilerForTests();
    const f = await fixture();
    const cancelled = await f.build("BUILDING");
    await prisma.durableJob.update({
      where: { id: cancelled.jobId },
      data: { state: "CANCELLED" },
    });
    for (let i = 0; i < 120; i++) touch(f.kbId, `keep-${String(i).padStart(4, "0")}`, false);
    const orphan = touch(f.kbId, `${cancelled.generationId}.a1.tmp`);
    const perDir = new Map<string, number>();
    const warn = captureLog();
    try {
      await reconcileIndexFiles({
        ...retention,
        indexDirEntryCap: 50,
        openIndexDir: async (path: string) => {
          const dir = await opendir(path);
          return {
            close: () => dir.close(),
            async *[Symbol.asyncIterator]() {
              for await (const entry of dir) {
                perDir.set(path, (perDir.get(path) ?? 0) + 1);
                yield entry;
              }
            },
          };
        },
      });
      expect(warn.records).toContainEqual(
        expect.objectContaining({
          site: "kb.retention",
          kbId: f.kbId,
          reason: "INDEX_DIR_OVER_CAP",
        }),
      );
    } finally {
      warn.restore();
    }
    expect(perDir.get(join(indexDir, f.kbId))).toBe(51);
    for (const reads of perDir.values()) expect(reads).toBeLessThanOrEqual(51);
    // The over-cap directory is left alone (an operator must look at it).
    expect(existsSync(orphan)).toBe(true);
    for (let i = 0; i < 120; i++)
      rmSync(join(indexDir, f.kbId, `keep-${String(i).padStart(4, "0")}`), { force: true });
    rmSync(orphan, { force: true });
  });

  it("purge skips a generation under a read's FOR KEY SHARE, then purges and unlinks after commit", async () => {
    const f = await fixture();
    const a = f.first.generationId;
    await f.build();
    expect((await rows(a)).state).toBe("SUPERSEDED");
    const reader = new Client({ connectionString: db.urls.runtime });
    await reader.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await reader.query("SELECT id FROM index_generation g WHERE id=$1 FOR KEY SHARE OF g", [a]);
      // Counts are not asserted: earlier tests' retired generations share this database.
      await purgeRetiredGenerations({ ...retention, now: later(8 * DAY) });
      expect(await rows(a)).toEqual({ state: "SUPERSEDED", files: 1, documents: 1 });
    } finally {
      await reader.query("COMMIT").catch(() => {});
      await reader.end();
    }
    expect(
      (await purgeRetiredGenerations({ ...retention, now: later(8 * DAY) })).purged,
    ).toBeGreaterThanOrEqual(1);
    expect(await rows(a)).toEqual({ state: "PURGED", files: 0, documents: 0 });
  });
});

describe("query data deadline", () => {
  async function seedQueries(
    kbId: string,
    generationId: string,
    userId: string,
    n: number,
    age: number,
  ) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const rid = randomUUID();
      ids.push(rid);
      await sql(
        `INSERT INTO durable_job (id,"dedupKey",kind,desired,state,"completedAt") VALUES ($1,$2,'QUERY_EMBEDDING',$3::jsonb,'COMPLETE',now())`,
        [rid, `query:${rid}`, JSON.stringify({ requestId: rid })],
      );
      await sql(
        `INSERT INTO query_embedding_request (id,"kbId","generationId","actorKey","userId",principal,snapshot,"resultCiphertext",state,deadline,"createdAt","scrubAt")
         VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'{}'::jsonb,'ciphertext','READY',
           clock_timestamp()-($6*interval '1 millisecond')+interval '60 seconds',
           clock_timestamp()-($6*interval '1 millisecond'),
           clock_timestamp()-($6*interval '1 millisecond')+($7*interval '1 millisecond'))`,
        [rid, kbId, generationId, `user:${userId}`, userId, age, RETENTION.queryScrubMs],
      );
      await sql(
        `INSERT INTO generation_lease ("requestId","generationId","expiresAt")
         SELECT id,"generationId","createdAt"+interval '90 seconds' FROM query_embedding_request WHERE id=$1`,
        [rid],
      );
    }
    return ids;
  }
  const count = async (ids: string[]) =>
    (
      await sql(
        "SELECT (SELECT count(*)::int FROM query_embedding_request WHERE id = ANY($1::text[])) AS requests, (SELECT count(*)::int FROM durable_job WHERE id = ANY($1::text[])) AS jobs",
        [ids],
      )
    ).rows[0];

  it("the real janitor removes an orphan before its imminent creation+5m deadline while preserving fresh/live requests", async () => {
    const f = await fixture();
    const orphan = await seedQueries(
      f.kbId,
      f.first.generationId,
      f.reader.id,
      1,
      RETENTION.queryScrubMs - 800,
    );
    const fresh = await seedQueries(f.kbId, f.first.generationId, f.reader.id, 1, 1000);
    const live = await seedQueries(f.kbId, f.first.generationId, f.reader.id, 1, 1000);
    await sql(
      `UPDATE query_embedding_request SET "scrubAt"=clock_timestamp()+interval '800 milliseconds', "queryCiphertext"=$2 WHERE id=$1`,
      [live[0], QUERY_CANARY],
    );
    const { startKbStagingCleanup } = await import(
      new URL("../../../../apps/server/src/kb-staging-cleanup.ts", import.meta.url).href
    );
    const cleanup = await startKbStagingCleanup({
      connectionString: db.urls.runtime,
      assertFence() {},
    });
    try {
      // Startup owns admission and must act before the next 30s tick. On the old
      // predicate this orphan survives startup and then crosses its hard deadline.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(await count(orphan)).toEqual({ requests: 0, jobs: 0 });
      expect(await count(fresh)).toEqual({ requests: 1, jobs: 1 });
      expect(await count(live)).toEqual({ requests: 1, jobs: 1 });
      await sql(
        `UPDATE generation_lease SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "requestId"=$1`,
        [live[0]],
      );
      await scrubExpiredQueryData({ connectionString: db.urls.runtime });
      expect(await count(live)).toEqual({ requests: 0, jobs: 0 });
    } finally {
      await cleanup.stop();
    }
  });

  it("scrubs >page-size rows across a crash between pages and resumes without touching live rows", async () => {
    const f = await fixture();
    const g = f.first.generationId;
    const expired = await seedQueries(f.kbId, g, f.reader.id, 7, RETENTION.queryScrubMs + 60_000);
    const fresh = await seedQueries(f.kbId, g, f.reader.id, 1, 1_000);
    let pages = 0;
    await expect(
      scrubExpiredQueryData({
        connectionString: db.urls.runtime,
        pageSize: 3,
        afterPage: () => {
          pages += 1;
          if (pages === 1) throw new Error("injected crash between pages");
        },
      }),
    ).rejects.toThrow("injected crash");
    expect((await count(expired)).requests).toBe(4);
    const resumed = await scrubExpiredQueryData({ connectionString: db.urls.runtime, pageSize: 3 });
    expect(resumed).toBe(4);
    expect(await count(expired)).toEqual({ requests: 0, jobs: 0 });
    expect(await count(fresh)).toEqual({ requests: 1, jobs: 1 });
    // Live lease with an already-passed scrubAt is never deleted underneath its reader.
    const leased = await seedQueries(f.kbId, g, f.reader.id, 1, 1_000);
    await sql(
      `UPDATE query_embedding_request SET "scrubAt"=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [leased[0]],
    );
    await scrubExpiredQueryData({ connectionString: db.urls.runtime });
    expect(await count(leased)).toEqual({ requests: 1, jobs: 1 });
    // The minute class (not the hourly one) enforces the 5-minute deadline. In real time a
    // request's 90s lease has ended long before its scrubAt; model that for `fresh`.
    await sql(
      `UPDATE generation_lease SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "requestId"=$1`,
      [fresh[0]],
    );
    await runKbRetention("minute", {
      connectionString: db.urls.runtime,
      indexDir,
      now: later(RETENTION.queryScrubMs),
    });
    expect(await count(fresh)).toEqual({ requests: 0, jobs: 0 });
    expect(await count(leased)).toEqual({ requests: 1, jobs: 1 });
  });
});

describe("staging: worker marks in DB, server unlinks, quota released exactly once", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    // Native generation setup is not staging reclamation. Keep its bounded
    // setup hook separate from the unchanged retention-operation watchdog.
    f = await fixture();
  });
  it("expires >page-size uploads across a crash, never unlinks from the worker pass", async () => {
    const accountId = randomUUID();
    const total = 5;
    await sql(
      `INSERT INTO quota_account (id,dimension,"subjectId",committed,reserved,"updatedAt") VALUES ($1,'KB_HISTORY_BYTES',$2,0,$3,now())`,
      [accountId, `retention:${randomUUID()}`, total * 10],
    );
    const uploads: string[] = [];
    for (let i = 0; i < total; i++) {
      const uid = randomUUID();
      const rid = randomUUID();
      await sql(
        `INSERT INTO quota_reservation (id,"accountId",amount,"opId","expiresAt",outcome) VALUES ($1,$2,10,$3,now()+interval '1 hour','RESERVED')`,
        [rid, accountId, randomUUID()],
      );
      await sql(
        `INSERT INTO staged_upload (id,"kbId","actorKey","actorUserIdSnapshot",kind,"declaredSize","declaredHash","declaredMime","reservationIds","expiresAt",state,"createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'MARKDOWN',10,$5,'text/markdown',ARRAY[$6],now()-interval '1 second','WRITING',now()-interval '2 hours',now())`,
        [uid, f.kbId, `user:${f.owner.id}`, f.owner.id, `sha256:${"d".repeat(64)}`, rid],
      );
      writeFileSync(stagedUploadPath(assetsDir, uid), "partial");
      uploads.push(uid);
    }
    let pages = 0;
    await expect(
      markExpiredStagedUploads({
        connectionString: db.urls.runtime,
        pageSize: 2,
        afterPage: () => {
          pages += 1;
          if (pages === 1) throw new Error("injected crash between pages");
        },
      }),
    ).rejects.toThrow("injected crash");
    await markExpiredStagedUploads({ connectionString: db.urls.runtime, pageSize: 2 });
    await markExpiredStagedUploads({ connectionString: db.urls.runtime, pageSize: 2 });
    const account = async () =>
      (await sql("SELECT reserved::int AS reserved FROM quota_account WHERE id=$1", [accountId]))
        .rows[0].reserved;
    expect(await account()).toBe(0);
    const states = await sql(
      `SELECT u.state::text AS state, r.outcome::text AS outcome, u."stagingReclaimedAt" FROM staged_upload u JOIN quota_reservation r ON r.id = u."reservationIds"[1] WHERE u.id = ANY($1::uuid[])`,
      [uploads],
    );
    expect(states.rows.every((row) => row.state === "EXPIRED" && row.outcome === "RELEASED")).toBe(
      true,
    );
    expect(states.rows.every((row) => row.stagingReclaimedAt === null)).toBe(true);
    // The worker pass is DB-only: every staging file still exists.
    expect(uploads.every((uid) => existsSync(stagedUploadPath(assetsDir, uid)))).toBe(true);
    // Two overlapping server sweeps unlink each file and never release a quota twice.
    await Promise.all([
      sweepExpiredStagedUploads(db.urls.runtime, assetsDir),
      sweepExpiredStagedUploads(db.urls.runtime, assetsDir),
    ]);
    expect(uploads.some((uid) => existsSync(stagedUploadPath(assetsDir, uid)))).toBe(false);
    expect(await account()).toBe(0);
    const reclaimed = await sql(
      `SELECT count(*)::int AS n FROM staged_upload WHERE id = ANY($1::uuid[]) AND "stagingReclaimedAt" IS NOT NULL`,
      [uploads],
    );
    expect(reclaimed.rows[0].n).toBe(total);
  });
});

describe("operation receipt compaction", () => {
  it("compacts bodies after 30d; replay keeps shape/revision after live reauth; mismatch still rejected", async () => {
    const f = await fixture();
    const idem = key();
    const response = { operationId: randomUUID(), headSha: "e".repeat(40), changes: ["doc.md"] };
    await tx((q) =>
      recordFinalizedReceipt(q, {
        kbId: f.kbId,
        actorUserId: f.owner.id,
        operation: "CHANGES_APPLY",
        idempotencyKey: idem,
        requestHash: "h".repeat(64),
        responseBody: response,
      }),
    );
    await sql(
      `UPDATE operation_intent SET "preparedDelta"=$2::jsonb, "resultRevision"=$3 WHERE "idempotencyKey"=$1`,
      [
        idem,
        JSON.stringify({
          kind: "changes_apply",
          headSha: "e".repeat(40),
          changedPaths: ["doc.md"],
          dreamMetadata: { summary: SOURCE_CANARY },
          quotaReservationIds: ["q1"],
        }),
        "e".repeat(40),
      ],
    );
    const where = {
      actorKey: `user:${f.owner.id}`,
      kbId: f.kbId,
      operation: "CHANGES_APPLY",
      idempotencyKey: idem,
    };
    await compactOperationReceipts({
      connectionString: db.urls.runtime,
      now: later(RETENTION.operationBodyMs - 60_000),
    });
    expect((await tx((q) => findOperationIntent(q, where))).preparedDelta).toMatchObject({
      dreamMetadata: { summary: SOURCE_CANARY },
    });
    expect(
      await compactOperationReceipts({
        connectionString: db.urls.runtime,
        now: later(RETENTION.operationBodyMs + 60_000),
      }),
    ).toBeGreaterThanOrEqual(1);
    const compacted = await tx((q) => findOperationIntent(q, where));
    expect(compacted).toMatchObject({
      phase: "FINALIZED",
      requestHash: "h".repeat(64),
      resultRevision: "e".repeat(40),
      resultStatus: "SUCCESS",
      responseBody: response,
      preparedDelta: {
        compacted: true,
        kind: "changes_apply",
        headSha: "e".repeat(40),
        quotaReservationIds: ["q1"],
      },
    });
    expect(JSON.stringify(compacted.preparedDelta)).not.toContain(SOURCE_CANARY);
    // Replay after live reauthorization returns the exact original response.
    const owner = { kind: "browser", userId: f.owner.id };
    expect(
      await tx((q) => replayFinalizedIntent(sqlAuthorityStore(q), owner, compacted, q)),
    ).toEqual(response);
    // A principal without live authority cannot replay the compacted receipt.
    await expect(
      tx((q) =>
        replayFinalizedIntent(
          sqlAuthorityStore(q),
          { kind: "browser", userId: f.reader.id },
          compacted,
          q,
        ),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Same key + different body stays IDEMPOTENCY_MISMATCH after compaction.
    await expect(
      tx((q) =>
        recordFinalizedReceipt(q, {
          kbId: f.kbId,
          actorUserId: f.owner.id,
          operation: "CHANGES_APPLY",
          idempotencyKey: idem,
          requestHash: "x".repeat(64),
          responseBody: { other: true },
        }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    // Idempotent: a second pass finds nothing left to compact for this row.
    const again = await tx((q) => findOperationIntent(q, where));
    expect(again.preparedDelta).toEqual(compacted.preparedDelta);
  });
});

describe("audit retention and export", () => {
  it("deletes events older than 90d, keeps younger ones, and exports pages to admins", async () => {
    const old = randomUUID();
    const young = randomUUID();
    for (const [opId, ageDays] of [
      [old, 91],
      [young, 89],
    ] as const)
      await sql(
        `INSERT INTO audit_event (id,"createdAt","opId",action,outcome,"actorKey","actorUserIdSnapshot",metadata)
         VALUES ($1,now()-($2*interval '1 day'),$3,'kb_update','SUCCESS','user:x','x','{}'::jsonb)`,
        [id(), ageDays, opId],
      );
    expect(
      await deleteExpiredAuditEvents({ connectionString: db.urls.runtime }),
    ).toBeGreaterThanOrEqual(1);
    const left = await sql('SELECT "opId" FROM audit_event WHERE "opId" = ANY($1::text[])', [
      [old, young],
    ]);
    expect(left.rows.map((row) => row.opId)).toEqual([young]);
    const page = await listAuditEventsForExport(prisma, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await listAuditEventsForExport(prisma, { limit: 500, cursor: page.nextCursor });
    expect(next.items.some((item) => item.opId === page.items[0].opId)).toBe(false);
  });

  it("never records canary provider keys, query text or source bodies in audit rows", async () => {
    const all = await sql("SELECT row_to_json(a)::text AS row FROM audit_event a");
    const text = all.rows.map((row) => row.row).join("\n");
    expect(text.length).toBeGreaterThan(0);
    for (const canary of [PROVIDER_KEY_CANARY, QUERY_CANARY, SOURCE_CANARY])
      expect(text).not.toContain(canary);
  });
});

describe("credential artifact retention", () => {
  it("applies device/OAuth/refresh-family/DPoP windows and keeps grant/consent tombstones and JWKS", async () => {
    const u = await user();
    const hour = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms);
    await prisma.oauthClient.create({ data: { clientId: "retention-client" } });
    const mk = {
      device: (digest: string, expiresAt: Date) =>
        prisma.deviceCode.create({
          data: {
            deviceCodeDigest: digest,
            userCode: digest.slice(0, 8),
            expiresAt,
            status: "pending",
          },
        }),
      verification: (identifier: string, expiresAt: Date) =>
        prisma.verification.create({ data: { id: id(), identifier, value: "v", expiresAt } }),
      access: (token: string, expiresAt: Date) =>
        prisma.oauthAccessToken.create({
          data: { token, clientId: "retention-client", userId: u.id, expiresAt },
        }),
      refresh: (token: string, referenceId: string, expiresAt: Date, rotatedAt: Date | null) =>
        prisma.oauthRefreshToken.create({
          data: {
            token,
            clientId: "retention-client",
            userId: u.id,
            referenceId,
            expiresAt,
            rotatedAt,
          },
        }),
    };
    await mk.device("devicekeep0001", at(-23 * hour));
    await mk.device("devicegone0001", at(-25 * hour));
    await mk.verification("dpop-proof:keep", at(1_000));
    await mk.verification("dpop-proof:gone", at(-1));
    await mk.verification("oauth-code:keep", at(-23 * hour));
    await mk.verification("oauth-code:gone", at(-25 * hour));
    await mk.access("access-keep", at(-23 * hour));
    await mk.access("access-gone", at(-25 * hour));
    // Family "live": the rotated predecessor stays while its successor is live.
    await mk.refresh("refresh-live-old", "family-live", at(-30 * hour), at(-31 * hour));
    await mk.refresh("refresh-live-new", "family-live", at(40 * hour), null);
    // Family "dead": every member is past family expiry + 24h.
    await mk.refresh("refresh-dead-old", "family-dead", at(-26 * hour), at(-27 * hour));
    await mk.refresh("refresh-dead-new", "family-dead", at(-25 * hour), null);
    const jwks = await prisma.jwks.create({
      data: { publicKey: "pub", privateKey: "priv", expiresAt: at(-400 * 24 * hour) },
    });
    const grant = await prisma.mcpGrant.create({
      data: {
        id: randomUUID(),
        actorUserIdSnapshot: u.id,
        userId: u.id,
        kind: "OAUTH",
        clientId: "retention-client",
        referenceId: `ref-${randomUUID()}`,
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        createdKbBits: [],
        revokedAt: at(-400 * 24 * hour),
      },
    });
    const consent = (grantId: string | null, approvedAt: Date | null, expiresAt: Date) =>
      prisma.consentIntent.create({
        data: {
          referenceId: randomUUID(),
          nonce: randomUUID(),
          sessionDigest: randomUUID(),
          queryDigest: randomUUID(),
          actorUserIdSnapshot: u.id,
          userId: u.id,
          clientId: "retention-client",
          redirectUri: "https://client.example.invalid/cb",
          resource: "https://kb.example.invalid/mcp",
          scopes: ["mcp:read"],
          grantId,
          approvedAt,
          expiresAt,
        },
      });
    const tombstone = await consent(grant.id, at(-401 * 24 * hour), at(-400 * 24 * hour));
    const abandoned = await consent(null, null, at(-25 * hour));

    await reapExpiredAuthTokens(new Date(), prisma);

    const devices = await prisma.deviceCode.findMany({
      where: { deviceCodeDigest: { in: ["devicekeep0001", "devicegone0001"] } },
    });
    expect(devices.map((d) => d.deviceCodeDigest)).toEqual(["devicekeep0001"]);
    const verifications = await prisma.verification.findMany({
      where: {
        identifier: {
          in: ["dpop-proof:keep", "dpop-proof:gone", "oauth-code:keep", "oauth-code:gone"],
        },
      },
    });
    expect(verifications.map((v) => v.identifier).sort()).toEqual([
      "dpop-proof:keep",
      "oauth-code:keep",
    ]);
    const access = await prisma.oauthAccessToken.findMany({
      where: { clientId: "retention-client" },
    });
    expect(access.map((a) => a.token)).toEqual(["access-keep"]);
    const refresh = await prisma.oauthRefreshToken.findMany({
      where: { clientId: "retention-client" },
    });
    expect(refresh.map((r) => r.token).sort()).toEqual(["refresh-live-new", "refresh-live-old"]);
    expect(await prisma.jwks.count({ where: { id: jwks.id } })).toBe(1);
    expect(await prisma.mcpGrant.count({ where: { id: grant.id } })).toBe(1);
    expect(await prisma.consentIntent.count({ where: { id: tombstone.id } })).toBe(1);
    expect(await prisma.consentIntent.count({ where: { id: abandoned.id } })).toBe(0);
  });
});
