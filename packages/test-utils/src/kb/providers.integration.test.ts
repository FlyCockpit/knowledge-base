import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { removeUserAccount } from "@knowledge-base/api/lib/kb/account-removal";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { requestOpenAiEmbeddings } from "@knowledge-base/api/lib/kb/embed-client";
import {
  createProviderEmbedder,
  runProviderProbeDelivery,
} from "@knowledge-base/api/lib/kb/embedder";
import { decryptKbSecret, type KbEncryptedRecord } from "@knowledge-base/api/lib/kb/envelope";
import {
  claimDispatchBatch,
  durableBullmqJobId,
  MAX_DURABLE_RETRY_ATTEMPTS,
  retryDurableJob,
} from "@knowledge-base/api/lib/kb/jobs";
import { createMemoryRatePort, KB_LIMITS } from "@knowledge-base/api/lib/kb/limits";
import {
  createProvider,
  expireStalledProviderProbes,
  listMyProviders,
  PROVIDER_PROBE_STALL_MS,
  PROVIDER_PROBE_TIMEOUT_ERROR,
  probeProvider,
  revokeProvider,
} from "@knowledge-base/api/lib/kb/providers";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { Secret } from "@knowledge-base/env/secret";
import { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openKbPostgresClusterFromEnv, openKbRedisFromEnv, startPublicHttpFixture } from "./index";

// Only the socket connector is redirected in this test process. Production URL validation,
// exact path, headers, bounded response reading, timeout and adapter validation still run.
const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: wire.request }));
let responseBody = '{"data":[{"index":0,"embedding":[3,4]}]}';
let pause: { entered: () => void; resumed: Promise<void> } | undefined;
const http = await startPublicHttpFixture({
  handler: (_req, res) => {
    const gate = pause;
    const send = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    };
    if (gate) {
      gate.entered();
      void gate.resumed.then(send);
    } else send();
  },
});
wire.request.mockImplementation((url: URL, options: RequestOptions) => {
  if (url.hostname !== "provider.example.invalid") throw new Error("Unexpected network target");
  return httpRequest(`${http.origin}${url.pathname}`, { ...options, lookup: undefined });
});
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const redis = openKbRedisFromEnv();
const queue = new Queue("provider-probe", {
  connection: redis.client(),
  prefix: redis.key("bull"),
});
const runtime: KbRuntimeConfig = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir: "/unused",
  assetsDir: "/unused",
  blobStore: createDiskBlobStore("/unused"),
  canonicalOrigin: "https://kb.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  coordinator: {
    run: (options) =>
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: options.opId,
        kind: options.kind === "authority" ? "authority" : "kb-write",
        kbIds: options.kbIds,
        barrier: options.barrier,
        run: (lease) =>
          options.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability() {
              throw new Error("No Git in provider fixture");
            },
          }),
      }),
  },
};
const master = randomBytes(32);
const masterKey = master.toString("base64");
const config = {
  name: "Fixture",
  endpointUrl: "https://provider.example.invalid:8443/tenant/exact",
  model: "fixture",
  dimensions: 2,
  apiKey: "fixture-private-canary",
};
const revisionRow = (jobId: string) =>
  prisma.providerRevision.findFirstOrThrow({ where: { jobId } });
const jobRow = (id: string) => prisma.durableJob.findUniqueOrThrow({ where: { id } });
const input = () => ({ ...config, idempotencyKey: randomUUID() });
const user = () =>
  prisma.user.create({
    data: { name: "Fixture", email: `${randomUUID()}@example.invalid`, emailVerified: true },
  });
async function seedUserAtRevisionCap(ownerId: string) {
  const providers = Array.from({ length: KB_LIMITS.providersPerUser }, (_, index) => ({
    id: `p${randomUUID().replaceAll("-", "").slice(0, 23)}`,
    ownerId,
    name: `seed-${index}`,
    kind: "OPENAI_COMPAT" as const,
    revokedAt: new Date(),
  }));
  await prisma.embeddingProvider.createMany({ data: providers });
  const jobs: {
    id: string;
    dedupKey: string;
    kind: "PROVIDER_PROBE";
    desired: { providerId: string; revision: number; ownerId: string };
    state: "CANCELLED";
    cancelledAt: Date;
  }[] = [];
  const revisions: {
    providerId: string;
    version: number;
    endpointUrl: string;
    model: string;
    dimensions: number;
    ciphertext: null;
    ownerSnapshot: string;
    fingerprint: string;
    idempotencyKey: string;
    requestHash: string;
    jobId: string;
  }[] = [];
  for (const provider of providers) {
    for (let version = 1; version <= KB_LIMITS.providerRevisionsPerProvider; version += 1) {
      const jobId = randomUUID();
      jobs.push({
        id: jobId,
        dedupKey: `seed:${provider.id}:${version}`,
        kind: "PROVIDER_PROBE",
        desired: { providerId: provider.id, revision: version, ownerId },
        state: "CANCELLED",
        cancelledAt: new Date(),
      });
      revisions.push({
        providerId: provider.id,
        version,
        endpointUrl: "https://example.com/embed",
        model: "m",
        dimensions: 2,
        ciphertext: null,
        ownerSnapshot: ownerId,
        fingerprint: `seed-${provider.id}-${version}`,
        idempotencyKey: randomUUID(),
        requestHash: randomBytes(32).toString("hex"),
        jobId,
      });
    }
  }
  await prisma.durableJob.createMany({ data: jobs });
  await prisma.providerRevision.createMany({ data: revisions });
}
const dispatcher = {
  db: prisma,
  ownerId: "test-dispatcher",
  now: () => new Date(),
  getQueue: (name: string) => {
    expect(name).toBe("provider-probe");
    return queue;
  },
};
async function probe(jobId: string) {
  await runDurableDispatcherCycle(dispatcher);
  return runProviderProbeDelivery(prisma, {
    durableJobId: jobId,
    workerId: "fixture-worker",
    connectionString: db.urls.runtime,
    masterKey,
  });
}
function embedder(ownerId: string, providerId: string, revision = 1) {
  return createProviderEmbedder(
    { connectionString: db.urls.runtime, masterKey },
    { ownerId, providerId, revision },
  );
}
function barrier() {
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  pause = { entered, resumed };
  return { waiting, resume };
}
beforeEach(() => {
  pause = undefined;
  responseBody = '{"data":[{"index":0,"embedding":[3,4]}]}';
  runtime.ratePort = createMemoryRatePort();
});
afterAll(async () => {
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  await http.close();
});

describe("providers durable registry and real fake HTTP", () => {
  it("empty list; create commits encrypted revision before Redis, replay is one job; probe becomes ready", async () => {
    const owner = await user();
    expect(await listMyProviders(runtime, owner.id)).toEqual({ items: [], nextCursor: null });
    const request = input();
    const [created, replayed] = await Promise.all([
      createProvider(runtime, owner.id, request, masterKey),
      createProvider(runtime, owner.id, request, masterKey),
    ]);
    expect(created.provider.status).toBe("unavailable");
    expect(replayed).toEqual(created);
    expect(
      await prisma.providerRevision.count({ where: { providerId: created.provider.providerId } }),
    ).toBe(1);
    expect(await queue.getJob(durableBullmqJobId(created.jobId, 1))).toBeUndefined();
    const revision = await prisma.providerRevision.findUniqueOrThrow({
      where: { providerId_version: { providerId: created.provider.providerId, version: 1 } },
    });
    expect(revision.ciphertext).not.toContain(config.apiKey);
    expect(
      decryptKbSecret(
        JSON.parse(revision.ciphertext!) as KbEncryptedRecord,
        {
          aadVersion: 1,
          purpose: "provider-secret",
          userId: owner.id,
          objectId: revision.providerId,
          revision: "1",
        },
        master,
      ),
    ).toBe(config.apiKey);
    expect(await probe(created.jobId)).toEqual({ ready: true });
    expect((await queue.getJob(durableBullmqJobId(created.jobId, 1)))!.data).toEqual({
      durableJobId: created.jobId,
    });
    const listed = await listMyProviders(runtime, owner.id);
    expect(listed.items[0]!.status).toBe("ready");
    expect(Object.keys(listed.items[0]!).sort()).toEqual([
      "contextTokens",
      "dimensions",
      "kind",
      "model",
      "name",
      "probe",
      "providerId",
      "revision",
      "status",
    ]);
    expect(listed.items[0]!.probe).toEqual({ state: "ready", reason: null, failure: null });
    expect(JSON.stringify(listed)).not.toContain(config.apiKey);
    expect(JSON.stringify(listed)).not.toContain(config.endpointUrl);
    expect(http.requests.at(-1)!.url).toBe("/tenant/exact");
    expect(http.requests.at(-1)!.headers.authorization).toBe(`Bearer ${config.apiKey}`);
    expect(await probe(created.jobId)).toEqual({ skipped: true });
  });
  it("a worker-failed probe is terminal FAILED with a reason; a stuck probe times out and stays terminal", async () => {
    const owner = await user();
    // Pending while it is still moving.
    const pending = await createProvider(runtime, owner.id, input(), masterKey);
    expect((await listMyProviders(runtime, owner.id)).items[0]!.probe).toEqual({
      state: "pending",
      reason: null,
      failure: null,
    });

    // Worker failure on the last allowed attempt → terminal FAILED, stable reason, no secret.
    runtime.ratePort = createMemoryRatePort();
    const failing = await createProvider(runtime, owner.id, input(), masterKey);
    await prisma.durableJob.update({
      where: { id: failing.jobId },
      data: { attemptCount: MAX_DURABLE_RETRY_ATTEMPTS },
    });
    responseBody = `{"error":"${config.apiKey}"}`;
    await expect(probe(failing.jobId)).rejects.toThrow(/^Embedding provider unavailable$/);
    expect((await jobRow(failing.jobId)).state).toBe("FAILED");
    const afterFailure = await listMyProviders(runtime, owner.id);
    const failed = afterFailure.items.find((i) => i.providerId === failing.provider.providerId)!;
    expect(failed.status).toBe("unavailable");
    expect(failed.probe).toEqual({
      state: "failed",
      reason: "provider_error",
      // The fixture answers 200 with a non-embeddings body.
      failure: { kind: "bad_response" },
    });
    expect(JSON.stringify(afterFailure)).not.toContain(config.apiKey);

    // No worker ever runs `pending`: once it stops moving for the stall window, the
    // owner's read makes it terminal (FAILED + timeout reason, epoch fenced).
    const before = await jobRow(pending.jobId);
    // The dispatcher cycle above may have published it; no worker ever claimed it.
    expect(["PENDING", "PUBLISHED"]).toContain(before.state);
    await prisma.$executeRaw`UPDATE durable_job SET "nextRunAt" = ${new Date(Date.now() - PROVIDER_PROBE_STALL_MS - 5_000)} WHERE id = ${pending.jobId}`;
    const timedOut = (await listMyProviders(runtime, owner.id)).items.find(
      (i) => i.providerId === pending.provider.providerId,
    )!;
    expect(timedOut.probe).toEqual({ state: "timeout", reason: "timeout", failure: null });
    const expired = await jobRow(pending.jobId);
    expect(expired).toMatchObject({ state: "FAILED", lastError: PROVIDER_PROBE_TIMEOUT_ERROR });
    expect(expired.attemptEpoch).toBe(before.attemptEpoch + 1);
    // A late delivery can neither claim nor complete it: it never turns "ready".
    responseBody = '{"data":[{"index":0,"embedding":[3,4]}]}';
    await probe(pending.jobId).catch(() => undefined);
    expect((await jobRow(pending.jobId)).state).toBe("FAILED");
    const again = (await listMyProviders(runtime, owner.id)).items.find(
      (i) => i.providerId === pending.provider.providerId,
    )!;
    expect(again.probe).toEqual({ state: "timeout", reason: "timeout", failure: null });
    expect(again.status).toBe("unavailable");
    // A healthy recent probe is never swept.
    expect(await expireStalledProviderProbes(prisma, owner.id)).toBe(0);
  });
  it("R46r3 F1: repeated Redis publication and failed scheduling cannot renew an unconsumed probe", async () => {
    const owner = await user();
    const published = await createProvider(runtime, owner.id, input(), masterKey);
    const unpublished = await createProvider(runtime, owner.id, input(), masterKey);
    const stale = new Date(Date.now() - PROVIDER_PROBE_STALL_MS - 5_000);
    await prisma.durableJob.updateMany({
      where: { id: { in: [published.jobId, unpublished.jobId] } },
      data: { nextRunAt: stale },
    });
    const failingDispatcher = {
      ...dispatcher,
      getQueue: () => ({
        getJob: (id: string) => queue.getJob(id),
        add: async () => {
          throw new Error("fixture unavailable");
        },
      }),
    };
    // Exercise claim+release on real SQL first, then real idempotent Redis add+ack.
    for (let cycle = 0; cycle < 3; cycle++) await runDurableDispatcherCycle(failingDispatcher);
    expect((await jobRow(unpublished.jobId)).state).toBe("PENDING");
    expect((await jobRow(unpublished.jobId)).nextRunAt).toEqual(stale);
    // Exclude that sibling while testing real Redis publication of the other job.
    await prisma.durableJob.update({
      where: { id: unpublished.jobId },
      data: { dispatchClaimUntil: new Date(Date.now() + 60_000) },
    });
    for (let cycle = 0; cycle < 3; cycle++) await runDurableDispatcherCycle(dispatcher);
    const before = await jobRow(published.jobId);
    expect(before).toMatchObject({ state: "PUBLISHED", attemptCount: 0, lastHeartbeatAt: null });
    expect(before.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(
      await queue.getJob(durableBullmqJobId(published.jobId, before.attemptEpoch)),
    ).not.toBeNull();
    const listed = await listMyProviders(runtime, owner.id);
    expect(listed.items.map((item) => item.probe)).toEqual([
      { state: "timeout", reason: "timeout", failure: null },
      { state: "timeout", reason: "timeout", failure: null },
    ]);
    for (const id of [published.jobId, unpublished.jobId]) {
      expect(await jobRow(id)).toMatchObject({
        state: "FAILED",
        attemptCount: 0,
        attemptEpoch: 2,
        workerOwner: null,
        dispatchOwner: null,
        dispatchClaimUntil: null,
      });
      expect(await probe(id)).toEqual({ skipped: true });
    }
  });
  it("R46r3 F1: live worker heartbeats keep a slow healthy HTTP probe pending, then ready", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    await prisma.durableJob.update({
      where: { id: created.jobId },
      data: { nextRunAt: new Date(0) },
    });
    const gate = barrier();
    const running = probe(created.jobId);
    await gate.waiting;
    try {
      const initial = (await jobRow(created.jobId)).lastHeartbeatAt!;
      // The production heartbeat timer, not a simulated heartbeat update.
      await new Promise((resolve) => setTimeout(resolve, 5_400));
      const live = await jobRow(created.jobId);
      expect(live.lastHeartbeatAt!.getTime()).toBeGreaterThan(initial.getTime());
      expect(await expireStalledProviderProbes(prisma, owner.id)).toBe(0);
      expect((await listMyProviders(runtime, owner.id)).items[0]!.probe.state).toBe("pending");
    } finally {
      gate.resume();
    }
    expect(await running).toEqual({ ready: true });
    expect((await listMyProviders(runtime, owner.id)).items[0]!.probe.state).toBe("ready");
  });
  it("R46r3 F1: timeout during real pending HTTP fences the late response and redelivery", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    const gate = barrier();
    const running = probe(created.jobId);
    const settled = running.then(
      (result) => result,
      (error: unknown) => error,
    );
    await gate.waiting;
    try {
      await prisma.durableJob.update({
        where: { id: created.jobId },
        data: { lastHeartbeatAt: new Date(0) },
      });
      expect((await listMyProviders(runtime, owner.id)).items[0]!.probe.state).toBe("timeout");
      expect(await jobRow(created.jobId)).toMatchObject({
        state: "FAILED",
        attemptEpoch: 2,
        workerOwner: null,
        leaseUntil: null,
        lastHeartbeatAt: null,
      });
    } finally {
      gate.resume();
      await settled;
    }
    expect(await settled).toMatchObject({ code: "INDEX_UNAVAILABLE" });
    expect(await probe(created.jobId)).toEqual({ skipped: true });
    expect((await listMyProviders(runtime, owner.id)).items[0]!.probe.state).toBe("timeout");
  });
  it("fake HTTP accepts only valid index permutations, count, finite f32/norm and 1..2000 dimensions", async () => {
    const request = { ...config, apiKey: new Secret(config.apiKey), dimensions: 2 };
    responseBody = JSON.stringify({
      data: [
        { index: 1, embedding: [0, 7] },
        { index: 0, embedding: [3, 4] },
      ],
    });
    // Raw values in input order: the index format normalizes exactly once (§1.4).
    expect(await requestOpenAiEmbeddings(request, ["a", "b"])).toEqual([
      [3, 4],
      [0, 7],
    ]);
    for (const data of [
      [
        { index: 0, embedding: [1, 2] },
        { index: 0, embedding: [1, 2] },
      ],
      [
        { index: -1, embedding: [1, 2] },
        { index: 0, embedding: [1, 2] },
      ],
      [{ index: 0, embedding: [1, 2] }],
      [
        { index: 0, embedding: [1, 2] },
        { index: 2, embedding: [1, 2] },
      ],
    ]) {
      responseBody = JSON.stringify({ data });
      await expect(requestOpenAiEmbeddings(request, ["a", "b"])).rejects.toMatchObject({
        code: "INDEX_UNAVAILABLE",
      });
    }
    for (const vector of ["[NaN,1]", "[1e400,1]", "[1e39,1]", "[0,0]", "[1]", "[1e-50,0]"]) {
      responseBody = `{"data":[{"index":0,"embedding":${vector}}]}`;
      await expect(requestOpenAiEmbeddings(request, ["x"])).rejects.toThrow(
        /^Embedding provider unavailable$/,
      );
    }
    for (const dimensions of [1, 2000, 2001]) {
      responseBody = JSON.stringify({ data: [{ index: 0, embedding: Array(dimensions).fill(1) }] });
      const result = requestOpenAiEmbeddings({ ...request, dimensions }, ["x"]);
      if (dimensions === 2001) await expect(result).rejects.toThrow();
      else expect((await result)[0]).toHaveLength(dimensions);
    }
  });
  it("rotates configuration/key by append only; pinned old revision still uses its own key; receipts reject changed input", async () => {
    const owner = await user();
    const request = input();
    const first = await createProvider(runtime, owner.id, request, masterKey);
    await probe(first.jobId);
    const before = await revisionRow(first.jobId);
    const { name: _name, ...rest } = input();
    const second = await probeProvider(
      runtime,
      owner.id,
      { ...rest, providerId: before.providerId, apiKey: "rotated-fixture" },
      masterKey,
    );
    const after = await revisionRow(second.jobId);
    expect(after.version).toBe(2);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(await revisionRow(first.jobId)).toEqual(before);
    await embedder(owner.id, before.providerId).embed(["x"], { purpose: "query" });
    expect(http.requests.at(-1)!.headers.authorization).toBe(`Bearer ${config.apiKey}`);
    await probe(second.jobId);
    expect(http.requests.at(-1)!.headers.authorization).toBe("Bearer rotated-fixture");
    await expect(
      createProvider(runtime, owner.id, { ...request, apiKey: "changed" }, masterKey),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const audit = await prisma.auditEvent.findMany({ where: { actorUserId: owner.id }, take: 20 });
    expect(JSON.stringify(audit)).not.toContain(config.apiKey);
    await revokeProvider(runtime, owner.id, { providerId: before.providerId });
    expect(
      await prisma.providerRevision.count({
        where: { providerId: before.providerId, ciphertext: { not: null } },
      }),
    ).toBe(0);
    await expect(
      probeProvider(
        runtime,
        owner.id,
        { ...rest, idempotencyKey: randomUUID(), providerId: before.providerId },
        masterKey,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("revoke while HTTP probe is paused erases ciphertext and fences late success plus redelivery", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    const gate = barrier();
    const running = probe(created.jobId);
    const rejected = expect(running).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    await gate.waiting;
    try {
      await revokeProvider(runtime, owner.id, { providerId: created.provider.providerId });
    } finally {
      gate.resume();
    }
    await rejected;
    expect((await jobRow(created.jobId)).state).toBe("CANCELLED");
    expect((await revisionRow(created.jobId)).ciphertext).toBeNull();
    expect((await listMyProviders(runtime, owner.id)).items[0]!.status).toBe("revoked");
    expect(await probe(created.jobId)).toEqual({ skipped: true });
    expect(await retryDurableJob(prisma, created.jobId)).toBeNull();
  });
  it("lease expiry/replacement cannot publish a paused worker's success", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    const gate = barrier();
    const rejected = expect(probe(created.jobId)).rejects.toMatchObject({
      code: "INDEX_UNAVAILABLE",
    });
    await gate.waiting;
    try {
      await prisma.durableJob.update({
        where: { id: created.jobId },
        data: { leaseUntil: new Date(0) },
      });
      await claimDispatchBatch(prisma, { owner: "replacement", now: new Date() });
    } finally {
      gate.resume();
    }
    await rejected;
    const row = await jobRow(created.jobId);
    expect(row.state).toBe("RETRY");
    expect(row.attemptEpoch).toBe(2);
    pause = undefined;
    await prisma.durableJob.update({
      where: { id: created.jobId },
      data: { nextRunAt: new Date(0) },
    });
    expect(await probe(created.jobId)).toEqual({ ready: true });
  });
  it("another KB manager cannot list, probe, revoke or use the owner's provider; live ban denies use", async () => {
    const owner = await user(),
      other = await user();
    const kb = await prisma.knowledgeBase.create({
      data: {
        ownerId: owner.id,
        name: "KB",
        slug: "test",
        description: "Fixture knowledge base",
        state: "ACTIVE",
        headSha: "a".repeat(40),
      },
    });
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: other.id, bits: ["manage"] } });
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    await probe(created.jobId);
    expect((await listMyProviders(runtime, other.id)).items).toEqual([]);
    const { name: _name, ...rest } = input();
    const providerId = created.provider.providerId;
    await expect(
      probeProvider(runtime, other.id, { ...rest, providerId }, masterKey),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(revokeProvider(runtime, other.id, { providerId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const count = http.requests.length;
    await expect(
      embedder(other.id, providerId).embed(["x"], { purpose: "query" }),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    await prisma.user.update({ where: { id: owner.id }, data: { banned: true } });
    await expect(
      embedder(owner.id, providerId).embed(["x"], { purpose: "document" }),
    ).rejects.toThrow();
    expect(http.requests).toHaveLength(count);
  });
  it("ordinary account removal with zero KBs erases all credentials, nulls ownership, and fences a paused probe", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    const gate = barrier();
    const rejected = expect(probe(created.jobId)).rejects.toMatchObject({
      code: "INDEX_UNAVAILABLE",
    });
    await gate.waiting;
    try {
      await removeUserAccount(runtime, owner.id, { actingUserId: owner.id });
    } finally {
      gate.resume();
    }
    await rejected;
    const provider = await prisma.embeddingProvider.findUniqueOrThrow({
      where: { id: created.provider.providerId },
    });
    expect(provider.ownerId).toBeNull();
    expect(provider.revokedAt).not.toBeNull();
    expect((await revisionRow(created.jobId)).ciphertext).toBeNull();
    await expect(
      embedder(owner.id, provider.id).embed(["x"], { purpose: "query" }),
    ).rejects.toThrow();
  });
  it("enforces shared 5/min probe budget, 20 live providers, pagination and redacted failure/retry", async () => {
    const owner = await user();
    const first = await createProvider(runtime, owner.id, input(), masterKey);
    const { name: _name, ...rest } = input();
    for (let i = 0; i < 4; i++)
      await probeProvider(
        runtime,
        owner.id,
        { ...rest, providerId: first.provider.providerId, idempotencyKey: randomUUID() },
        masterKey,
      );
    await expect(createProvider(runtime, owner.id, input(), masterKey)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    for (let i = 1; i < 20; i++) {
      runtime.ratePort = createMemoryRatePort();
      await createProvider(runtime, owner.id, input(), masterKey);
    }
    runtime.ratePort = createMemoryRatePort();
    await expect(createProvider(runtime, owner.id, input(), masterKey)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    const page = await listMyProviders(runtime, owner.id, { limit: 10 });
    expect(page.items).toHaveLength(10);
    const next = await listMyProviders(runtime, owner.id, { limit: 10, cursor: page.nextCursor! });
    expect(next.items).toHaveLength(10);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.items, ...next.items].map((item) => item.providerId)).size).toBe(20);
    responseBody = `{"error":"${config.apiKey}"}`;
    await expect(probe(first.jobId)).rejects.toThrow(/^Embedding provider unavailable$/);
    const job = await jobRow(first.jobId);
    expect(job.state).toBe("RETRY");
    // A stable failure code, never the provider's reply.
    expect(job.lastError).toBe("provider_probe:bad_response");
    expect(JSON.stringify(job)).not.toContain(config.apiKey);
  });
  it("rejects a new revision once the per-provider immutable revision cap is reached", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    const { name: _name, ...rest } = input();
    const providerId = created.provider.providerId;
    for (let i = 1; i < KB_LIMITS.providerRevisionsPerProvider; i++) {
      runtime.ratePort = createMemoryRatePort();
      await probeProvider(
        runtime,
        owner.id,
        { ...rest, providerId, idempotencyKey: randomUUID() },
        masterKey,
      );
    }
    expect(await prisma.providerRevision.count({ where: { providerId } })).toBe(
      KB_LIMITS.providerRevisionsPerProvider,
    );
    runtime.ratePort = createMemoryRatePort();
    await expect(
      probeProvider(
        runtime,
        owner.id,
        { ...rest, providerId, idempotencyKey: randomUUID() },
        masterKey,
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
  it("counts revoked provider revisions toward the per-user revision cap", async () => {
    const owner = await user();
    const created = await createProvider(runtime, owner.id, input(), masterKey);
    const { name: _name, ...rest } = input();
    const providerId = created.provider.providerId;
    for (let i = 1; i < KB_LIMITS.providerRevisionsPerProvider; i += 1) {
      runtime.ratePort = createMemoryRatePort();
      await probeProvider(
        runtime,
        owner.id,
        { ...rest, providerId, idempotencyKey: randomUUID() },
        masterKey,
      );
    }
    await revokeProvider(runtime, owner.id, { providerId });
    runtime.ratePort = createMemoryRatePort();
    await createProvider(runtime, owner.id, input(), masterKey);
    expect(await prisma.providerRevision.count({ where: { ownerSnapshot: owner.id } })).toBe(
      KB_LIMITS.providerRevisionsPerProvider + 1,
    );
  });
  it("rejects enrollment once the per-user revision cap is reached even with no live providers", async () => {
    const owner = await user();
    await seedUserAtRevisionCap(owner.id);
    expect(await prisma.providerRevision.count({ where: { ownerSnapshot: owner.id } })).toBe(
      KB_LIMITS.providerRevisionsPerUser,
    );
    runtime.ratePort = createMemoryRatePort();
    await expect(createProvider(runtime, owner.id, input(), masterKey)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });
});
