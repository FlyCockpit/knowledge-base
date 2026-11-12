import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountTeardown } from "@knowledge-base/api/lib/kb/account-removal";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { builtinModelIdentity } from "@knowledge-base/api/lib/kb/fingerprint";
import {
  cancelIndexBuildJobs,
  requestIndexBuild,
  scheduleIndexBuild,
} from "@knowledge-base/api/lib/kb/generations";
import { runIndexBuildDelivery } from "@knowledge-base/api/lib/kb/index-build";
import {
  generationFilePath,
  loadSqlite,
  readIndexFile,
  readStoredVector,
} from "@knowledge-base/api/lib/kb/index-file/testing";
import { getIndexProfile } from "@knowledge-base/api/lib/kb/index-status";
import {
  cancelDurableJob,
  claimDispatchBatch,
  DISPATCH_CLAIM_MS,
  heartbeatJobAttempt,
  MAX_DURABLE_RETRY_ATTEMPTS,
  releaseDispatchClaim,
  retryDurableJob,
} from "@knowledge-base/api/lib/kb/jobs";
import { createMemoryRatePort, KB_LIMITS } from "@knowledge-base/api/lib/kb/limits";
import {
  ensureSystemBuiltinProvider,
  SYSTEM_BUILTIN_PROVIDER_ID,
} from "@knowledge-base/api/lib/kb/local-model";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import { QWEN_ARTIFACT } from "@knowledge-base/api/lib/kb/model-artifact";
import { finalizeIntent } from "@knowledge-base/api/lib/kb/operation-intent";
import { createProvider, revokeProvider } from "@knowledge-base/api/lib/kb/providers";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import {
  DEFAULT_QWEN_RUNTIME_CONFIG,
  type QwenRuntimeConfig,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { releaseStaleBuildReservations } from "@knowledge-base/api/lib/kb/retention";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { listTransferLifecycleHandlersForTests } from "@knowledge-base/api/lib/kb/transfer";
import { captureLog } from "@knowledge-base/env/log";
import { Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startPublicHttpFixture } from "./http-fixture";
import { deliverIndexBuild } from "./index-delivery";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: wire.request }));
const sent: { model: string; input: string[] }[] = [];
/** The provider's raw reply per model (tests may register other dimensions). */
const replies = new Map<string, number[] | ((text: string) => number[])>([["fixture", [3, 4]]]);
const http = await startPublicHttpFixture({
  handler: (_req, res, body) => {
    const request = JSON.parse(body) as { model: string; input: string[] };
    sent.push(request);
    const reply = replies.get(request.model) ?? [3, 4];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: request.input.map((text, index) => ({
          index,
          embedding: typeof reply === "function" ? reply(text) : reply,
        })),
      }),
    );
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
const queue = new Queue("index-kb", { connection: redis.client(), prefix: redis.key("bull") });
const reposDir = mkdtempSync(join(tmpdir(), "kb-generations-"));
const indexDir = mkdtempSync(join(tmpdir(), "kb-generations-index-"));
const runtime: KbRuntimeConfig = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir,
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
            issueWriteCapability: () => {
              throw new Error("No canonical writes");
            },
          }),
      }),
  },
};
const key = () => randomUUID().replaceAll("-", "");
const id = () => `g${key().slice(0, 23)}`;
const masterKey = Buffer.alloc(32, 24).toString("base64");
const embedder = { embed: vi.fn(async (texts: readonly string[]) => texts.map(() => [0.6, 0.8])) };
function transaction<T>(run: (query: LockQuery) => Promise<T>) {
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) => lease.transaction(run),
  });
}
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
async function owner() {
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
async function provider(userId: string, model = "fixture", dimensions = 2) {
  const result = await createProvider(
    runtime,
    userId,
    {
      name: model,
      model,
      endpointUrl: "https://provider.example.invalid/embeddings",
      dimensions,
      apiKey: "test-only-placeholder",
      idempotencyKey: key(),
    },
    masterKey,
  );
  // Probe transport/SSRF is tested by providers suite; this suite consumes its successful durable result.
  await prisma.durableJob.update({ where: { id: result.jobId }, data: { state: "COMPLETE" } });
  return result.provider;
}
function source(kbId: string, files: Record<string, string>, parent?: string) {
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
    execFileSync("git", args, {
      cwd: repo,
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  if (!parent) execFileSync("git", ["init", "--bare", repo], { env, stdio: "ignore" });
  const manifest = git(["hash-object", "-w", "--stdin"], '{"version":1,"entries":[]}\n');
  const assets = git(["mktree"], `100644 blob ${manifest}\tmanifest.json\n`);
  const rows = [
    `040000 tree ${assets}\t.assets`,
    ...Object.entries(files).map(
      ([path, body]) => `100644 blob ${git(["hash-object", "-w", "--stdin"], body)}\t${path}`,
    ),
  ].sort();
  const tree = git(["mktree"], `${rows.join("\n")}\n`);
  const sha = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "fixture"]);
  git(["update-ref", "refs/heads/main", sha]);
  return sha;
}
async function fixture(
  files: Record<string, string> = { "source.md": "hello indexed world" },
  model?: { name: string; dimensions: number },
) {
  const user = await owner();
  const p = model ? await provider(user.id, model.name, model.dimensions) : await provider(user.id);
  const kbId = id();
  const sha = source(kbId, files);
  await prisma.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: user.id,
      name: "Fixture",
      slug: key(),
      description: "A test knowledge base",
      state: "ACTIVE",
      headSha: sha,
    },
  });
  const actor = { principal: { kind: "browser" as const, userId: user.id } };
  const attach = () =>
    requestIndexBuild(runtime, actor, {
      kbId,
      providerId: p.providerId,
      revision: 1,
      idempotencyKey: key(),
      confirm: "RUN",
    });
  return { user, p, kbId, sha, actor, attach };
}
async function publish() {
  await runDurableDispatcherCycle({
    db: prisma,
    ownerId: "test-dispatch",
    now: () => new Date(),
    getQueue: () => queue,
  });
}
async function run(
  jobId: string,
  hooks: Partial<Parameters<typeof deliverIndexBuild>[1]> = {},
  expected: Parameters<typeof deliverIndexBuild>[2] = {},
) {
  await publish();
  const result = await deliverIndexBuild(
    prisma,
    {
      connectionString: db.urls.runtime,
      reposDir,
      indexDir,
      masterKey,
      workerId: key(),
      durableJobId: jobId,
      embedder,
      ...hooks,
    },
    expected,
  );
  return result;
}
/** The active generation when it is semantic (a lexical companion does not count). */
async function semanticActive(kbId: string) {
  const id = await active(kbId);
  if (!id) return null;
  const g = await prisma.indexGeneration.findUniqueOrThrow({ where: { id } });
  return g.providerId === null ? null : id;
}
/** The lexical generation (companion) of one commit. */
async function lexicalOf(kbId: string, commitSha: string) {
  return (
    await prisma.indexGeneration.findFirstOrThrow({
      where: { kbId, commitSha, providerId: null },
      orderBy: { epoch: "desc" },
    })
  ).id;
}
async function active(kbId: string) {
  return (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } })).activeGenerationId;
}
/** Chunks of the generation's published index file; null when no file is published. */
async function counts(generationId: string) {
  const row = await prisma.indexGeneration.findUniqueOrThrow({ where: { id: generationId } });
  const path = generationFilePath(indexDir, row.kbId, generationId);
  return existsSync(path) ? readIndexFile(path).chunks.length : null;
}
/** Every file name of a generation in its KB directory (finals, temps, journals). */
function filesOf(kbId: string, generationId: string) {
  const dir = join(indexDir, kbId);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(generationId)) : [];
}
afterAll(async () => {
  await http.close();
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

describe("pinned generation build and activation", () => {
  it("R46r5 F1: external provider builds retain both global slots while the built-in permit is held", async () => {
    const permit = new Client({ connectionString: db.urls.runtime });
    await permit.connect();
    const paused = barrier();
    let running: Promise<unknown> | undefined;
    try {
      await permit.query("SELECT pg_advisory_lock(1262635337,2)");
      const a = await fixture();
      const b = await fixture();
      const first = await a.attach();
      const second = await b.attach();
      running = run(first.jobId, { afterChunks: paused.wait });
      await paused.entered;
      expect(await run(second.jobId)).toBe("COMPLETE");
      expect(await active(b.kbId)).toBe(second.generationId);
      paused.release();
      expect(await running).toBe("COMPLETE");
    } finally {
      paused.release();
      await running;
      await permit.end();
    }
  });
  it("attaches `builtin` without a revision to the CURRENT configuration after A -> B -> A", async () => {
    const f = await fixture();
    const saved = await prisma.localModel.findUnique({ where: { id: QWEN_ARTIFACT.modelId } });
    const job = await prisma.durableJob.create({
      data: { kind: "DOWNLOAD_MODEL", desired: {}, dedupKey: randomUUID(), state: "COMPLETE" },
    });
    // The system model becomes READY with `config`; its revision is the one
    // `ensureSystemBuiltinProvider` keeps for that configuration.
    const ready = async (config: QwenRuntimeConfig) => {
      const data = {
        state: "READY" as const,
        modelId: QWEN_MODEL.modelId,
        runtimeIdentity: builtinModelIdentity(QWEN_MODEL),
        ...config,
        jobId: job.id,
      };
      await prisma.localModel.upsert({
        where: { id: QWEN_ARTIFACT.modelId },
        create: { id: QWEN_ARTIFACT.modelId, ...data },
        update: data,
      });
      return runtime.coordinator.run({
        opId: randomUUID(),
        kind: "authority",
        run: ({ lease }) =>
          lease.transaction((query) =>
            ensureSystemBuiltinProvider(query, job.id, config, QWEN_ARTIFACT.modelId),
          ),
      });
    };
    try {
      const a = await ready(DEFAULT_QWEN_RUNTIME_CONFIG);
      const b = await ready({ contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q8_0" });
      expect(b).toBeGreaterThan(a);
      // Back to A: A's older revision is current, not the newest one (B).
      expect(await ready(DEFAULT_QWEN_RUNTIME_CONFIG)).toBe(a);
      const attached = await requestIndexBuild(runtime, f.actor, {
        kbId: f.kbId,
        providerId: "builtin",
        idempotencyKey: key(),
        confirm: "RUN",
      });
      expect(
        (await prisma.durableJob.findUniqueOrThrow({ where: { id: attached.jobId } })).desired,
      ).toMatchObject({ providerId: SYSTEM_BUILTIN_PROVIDER_ID, revision: a });
    } finally {
      if (saved) {
        // JSON null cannot be written back as-is (as the browser fixture does).
        const { id, configError, ...data } = saved;
        await prisma.localModel.update({
          where: { id },
          data: configError === null ? data : { ...data, configError },
        });
        if (configError === null)
          await prisma.$executeRaw`UPDATE kb_local_model SET "configError" = NULL WHERE id = ${id}`;
      } else await prisma.localModel.deleteMany({ where: { id: QWEN_ARTIFACT.modelId } });
    }
  });
  it("executes the production Embedder using only the pinned revision and validated vectors", async () => {
    const f = await fixture();
    const a = await f.attach();
    const before = sent.length;
    await run(a.jobId, { embedder: undefined });
    expect(sent.slice(before)).toEqual([
      { model: "fixture", input: ["hello indexed world"], dimensions: 2, encoding_format: "float" },
    ]);
    expect(await active(f.kbId)).toBe(a.generationId);
    const file = readIndexFile(generationFilePath(indexDir, f.kbId, a.generationId));
    expect(file.vectors).toBe(1);
    expect(file.journalMode).toBe("delete");
    // [3,4] → u = [0.6,0.8]; the one-vector calibration sample's 0.999-quantile is 0.6.
    expect(file.meta).toMatchObject({
      generation_id: a.generationId,
      kb_id: f.kbId,
      commit_sha: f.sha,
      dimensions: 2,
      quantization: "binary_int8_rescore",
      chunk_count: 1,
      document_count: 1,
    });
    expect(Number(file.meta.int8_scale)).toBeCloseTo(0.6, 6);
    expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.sqlite`]);
  });
  it("builds lexical-only by default and atomically attaches exactly one job despite replay", async () => {
    const f = await fixture();
    const lexical = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    expect((await getIndexProfile(runtime, f.actor, f.kbId)).index).toMatchObject({
      desiredEpoch: "1",
      desiredGenerationId: lexical!.generationId,
      freshness: "building",
      dimensions: null,
      fingerprint: null,
    });
    expect(
      await prisma.indexGeneration.findUniqueOrThrow({ where: { id: lexical!.generationId } }),
    ).toMatchObject({
      providerId: null,
      providerVersion: null,
      fingerprint: null,
      dimensions: null,
    });
    const input = {
      kbId: f.kbId,
      providerId: f.p.providerId,
      revision: 1,
      idempotencyKey: key(),
      confirm: "RUN" as const,
    };
    const a = await requestIndexBuild(runtime, f.actor, input);
    expect(await requestIndexBuild(runtime, f.actor, input)).toEqual(a);
    // The (unbuilt) lexical generation, the semantic build's lexical companion at epoch 2
    // (nothing serves the head commit yet) and exactly one hybrid one at epoch 3.
    expect(await prisma.indexGeneration.count({ where: { kbId: f.kbId } })).toBe(3);
    expect(
      await prisma.indexGeneration.count({ where: { kbId: f.kbId, epoch: 2n, providerId: null } }),
    ).toBe(1);
    expect(
      (await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).desired,
    ).toMatchObject({ commitSha: f.sha, providerId: f.p.providerId, revision: 1, epoch: "3" });
    await expect(
      requestIndexBuild(runtime, f.actor, { ...input, revision: 2 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await run(a.jobId);
    expect(await active(f.kbId)).toBe(a.generationId);
    expect((await getIndexProfile(runtime, f.actor, f.kbId)).index).toMatchObject({
      freshness: "current",
      dimensions: 2,
      fingerprint: expect.stringMatching(/^sha256:/),
    });
    const delivered = await queue.getJobs(["waiting", "completed"], 0, 100);
    expect(
      delivered.some((j) => j.data.durableJobId === a.jobId && Object.keys(j.data).length === 1),
    ).toBe(true);
  });

  it("walks the generation/attempt state machine: companion dependency in any delivery order, failure, retry, unusable profile, supersession, active older hybrid plus new head", async () => {
    const state = async (id: string) =>
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id } })).state;
    const companionOf = async (kbId: string) =>
      prisma.indexGeneration.findFirstOrThrow({
        where: { kbId, providerId: null, state: "PENDING" },
      });
    // scheduled -> PENDING, plus the lexical companion one epoch below (nothing serves yet).
    const f = await fixture();
    const a = await f.attach();
    const companion = await companionOf(f.kbId);
    expect(companion.commitSha).toBe(f.sha);
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } })).epoch,
    ).toBe(companion.epoch + 1n);
    // Reversed delivery: the semantic job is not claimed (no KB permit, no embedding)
    // while its companion is unbuilt.
    const calls = embedder.embed.mock.calls.length;
    await publish();
    expect(
      await runIndexBuildDelivery(prisma, {
        connectionString: db.urls.runtime,
        reposDir,
        indexDir,
        masterKey,
        workerId: key(),
        durableJobId: a.jobId,
        embedder,
      }),
    ).toEqual({ skipped: true });
    expect(await state(a.generationId)).toBe("PENDING");
    expect(embedder.embed.mock.calls.length).toBe(calls);
    // PENDING -> COMPLETE -> active (the companion keeps the KB searchable).
    expect(await run(companion.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(companion.id);
    expect((await getIndexProfile(runtime, f.actor, f.kbId)).index).toMatchObject({
      activeGenerationId: companion.id,
      desiredGenerationId: a.generationId,
      freshness: "building",
      fingerprint: null,
    });
    // BUILDING -> FAILED on a build error; the companion keeps serving.
    await expect(
      run(a.jobId, {
        embedder: {
          embed: async () => {
            throw new Error("provider down");
          },
        },
      }),
    ).rejects.toThrow("Index build failed");
    expect(await state(a.generationId)).toBe("FAILED");
    expect(await active(f.kbId)).toBe(companion.id);
    // A profile momentarily unusable at activation is an attempt failure, not supersession.
    await prisma.durableJob.update({ where: { id: a.jobId }, data: { state: "FAILED" } });
    await retryDurableJob(prisma, a.jobId);
    await expect(
      run(a.jobId, {
        beforeActivation: () =>
          prisma.embeddingProvider
            .update({ where: { id: f.p.providerId }, data: { revokedAt: new Date() } })
            .then(() => {}),
      }),
    ).rejects.toThrow("Index build failed");
    expect(await state(a.generationId)).not.toBe("SUPERSEDED");
    await prisma.embeddingProvider.update({
      where: { id: f.p.providerId },
      data: { revokedAt: null },
    });
    // The retried, still-desired build completes and replaces the companion.
    await prisma.durableJob.update({ where: { id: a.jobId }, data: { state: "FAILED" } });
    await retryDurableJob(prisma, a.jobId);
    expect(await run(a.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(a.generationId);
    expect(await state(companion.id)).toBe("SUPERSEDED");
    // A rebuild of an active semantic KB needs no companion. A newer
    // semantic@head completion outranks the active one until desired@head serves.
    const b = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    const c = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    expect(
      await prisma.indexGeneration.count({
        where: { kbId: f.kbId, providerId: null, state: "PENDING" },
      }),
    ).toBe(0);
    expect(await run(b.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(b.generationId);
    expect(await run(c.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(c.generationId);
    expect(await state(a.generationId)).toBe("SUPERSEDED");
    expect(await state(b.generationId)).toBe("SUPERSEDED");
    // Active older hybrid plus a new head (read-your-writes): lexical@head is scheduled,
    // serves as soon as it completes (the older hybrid retires) and keeps serving while
    // semantic@head fails; semantic@head then replaces it, reusing the retired hybrid's vectors.
    const head = source(
      f.kbId,
      { "source.md": "hello indexed world", "more.md": "another indexed note" },
      f.sha,
    );
    const d = await transaction(async (q) => {
      await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
      return scheduleIndexBuild(q, f.kbId);
    });
    const covering = await companionOf(f.kbId);
    expect(covering.commitSha).toBe(head);
    // Before the companion completes nothing of the head serves: the older hybrid does.
    expect(await active(f.kbId)).toBe(c.generationId);
    await publish();
    expect(
      await runIndexBuildDelivery(prisma, {
        connectionString: db.urls.runtime,
        reposDir,
        indexDir,
        masterKey,
        workerId: key(),
        durableJobId: covering.jobId,
      }),
    ).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(covering.id);
    expect(await state(c.generationId)).toBe("SUPERSEDED");
    // semantic@head building, then failing: the companion keeps serving throughout.
    const building = barrier();
    const failing = run(d!.jobId, {
      beforeReserve: building.wait,
      embedder: {
        embed: async () => {
          throw new Error("provider down");
        },
      },
    });
    try {
      await building.entered;
      expect(await state(d!.generationId)).toBe("BUILDING");
      expect(await active(f.kbId)).toBe(covering.id);
    } finally {
      building.release();
    }
    await expect(failing).rejects.toThrow("Index build failed");
    expect(await state(d!.generationId)).toBe("FAILED");
    expect(await active(f.kbId)).toBe(covering.id);
    // The retried semantic@head activates; the retired hybrid stays the vector-reuse source.
    await prisma.durableJob.update({ where: { id: d!.jobId }, data: { state: "FAILED" } });
    await retryDurableJob(prisma, d!.jobId);
    const embedded = embedder.embed.mock.calls.flatMap(([texts]) => texts).length;
    expect(await run(d!.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(d!.generationId);
    // The superseded companion is retired once semantic@head activates.
    expect(await state(covering.id)).toBe("SUPERSEDED");
    // Only the new chunk is embedded; the unchanged one is copied from the retired hybrid.
    expect(embedder.embed.mock.calls.flatMap(([texts]) => texts).length - embedded).toBe(1);
  });

  it.each(["head", "profile"])(
    "keeps newer B active when A finishes after a changed %s",
    async (change) => {
      const f = await fixture();
      const a = await f.attach();
      const gate = barrier();
      const pending = run(a.jobId, { beforeActivation: gate.wait });
      try {
        await gate.entered;
        expect(await semanticActive(f.kbId)).toBeNull();
        let b: Awaited<ReturnType<typeof f.attach>>;
        if (change === "head") {
          const sha = source(f.kbId, { "source.md": "new head document" }, f.sha);
          const built = await transaction(async (q) => {
            await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, sha]);
            return scheduleIndexBuild(q, f.kbId);
          });
          b = { operationId: randomUUID(), ...built! };
        } else {
          const p = await provider(f.user.id, "new-model");
          b = await requestIndexBuild(runtime, f.actor, {
            kbId: f.kbId,
            providerId: p.providerId,
            revision: 1,
            idempotencyKey: key(),
            confirm: "RUN",
          });
        }
        await run(b.jobId);
        expect(await active(f.kbId)).toBe(b.generationId);
        gate.release();
        expect(await pending).toBe("SUPERSEDED");
        expect(await active(f.kbId)).toBe(b.generationId);
        expect(
          (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } })).state,
        ).toBe("SUPERSEDED");
      } finally {
        gate.release();
        await pending.catch(() => {});
      }
    },
  );

  it("never activates between the finalized temp, the published file, and the final CAS", async () => {
    const f = await fixture();
    const a = await f.attach();
    const rows = barrier();
    const indexed = barrier();
    const pending = run(a.jobId, { afterChunks: rows.wait, beforeActivation: indexed.wait });
    try {
      await rows.entered;
      // Finalized under its temp name; nothing is published yet.
      expect(await counts(a.generationId)).toBeNull();
      expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.a1.tmp`]);
      expect(
        (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } }))
          .chunkCount,
      ).toBe(1);
      expect(await semanticActive(f.kbId)).toBeNull();
      await expect(
        prisma.indexGeneration.update({
          where: { id: a.generationId },
          data: { state: "COMPLETE" },
        }),
      ).rejects.toThrow();
      rows.release();
      await indexed.entered;
      expect(await semanticActive(f.kbId)).toBeNull();
      expect(
        (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } })).state,
      ).toBe("INDEXING");
      expect(await counts(a.generationId)).toBe(1);
      indexed.release();
      expect(await pending).toBe("COMPLETE");
    } finally {
      rows.release();
      indexed.release();
      await pending.catch(() => {});
    }
  });

  it("external providers retain 32-piece document batches and store every window", async () => {
    const body = Array.from({ length: 10_700 }, (_, i) => `word${i}`).join(" ");
    const f = await fixture({ "large.md": body });
    const a = await f.attach();
    const sizes: number[] = [];
    await run(a.jobId, {
      embedder: {
        embed: async (texts) => {
          sizes.push(texts.length);
          return texts.map(() => [0.6, 0.8]);
        },
      },
    });
    // 400-word windows with 80-word overlap yield 34 windows.
    expect(sizes).toEqual([32, 2]);
    expect(await counts(a.generationId)).toBe(34);
    expect(await active(f.kbId)).toBe(a.generationId);
  });

  it("a rebuild after a one-document edit embeds only the changed chunks and copies the rest", async () => {
    const large = Array.from({ length: 10_700 }, (_, i) => `word${i}`).join(" ");
    const f = await fixture({ "large.md": large, "other.md": "first version" });
    const a = await f.attach();
    const word = (text: string) => ({ text, vector: [1 + (text.length % 7), 2] });
    const seen: string[] = [];
    const counting = {
      embed: async (texts: readonly string[]) => {
        seen.push(...texts);
        return texts.map((text) => word(text).vector);
      },
    };
    await run(a.jobId, { embedder: counting });
    expect(seen).toHaveLength(35);
    const first = readIndexFile(generationFilePath(indexDir, f.kbId, a.generationId));
    expect(first.meta.format).toBe(2);
    const sha = source(f.kbId, { "large.md": large, "other.md": "second version" }, f.sha);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: sha } });
    const b = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    seen.length = 0;
    await run(b.jobId, { embedder: counting });
    expect(seen).toEqual(["second version"]);
    expect(await active(f.kbId)).toBe(b.generationId);
    const second = readIndexFile(generationFilePath(indexDir, f.kbId, b.generationId));
    expect(second.meta.int8_scale).toBe(first.meta.int8_scale);
    for (const chunk of second.chunks.filter((c) => c.path === "large.md"))
      expect(
        readStoredVector(generationFilePath(indexDir, f.kbId, b.generationId), chunk.id),
      ).toEqual(readStoredVector(generationFilePath(indexDir, f.kbId, a.generationId), chunk.id));
  });

  it("R3-L2: an unusable newest reuse candidate falls through to the next retained hybrid file", async () => {
    const large = Array.from({ length: 10_700 }, (_, i) => `word${i}`).join(" ");
    const f = await fixture({ "large.md": large, "other.md": "first version" });
    const a = await f.attach();
    const seen: string[] = [];
    const counting = {
      embed: async (texts: readonly string[]) => {
        seen.push(...texts);
        return texts.map((text) => [1 + (text.length % 7), 2]);
      },
    };
    await run(a.jobId, { embedder: counting });
    const edit = async (version: string, base: string) => {
      const sha = source(f.kbId, { "large.md": large, "other.md": version }, base);
      await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: sha } });
      const job = await requestIndexBuild(runtime, f.actor, {
        kbId: f.kbId,
        idempotencyKey: key(),
        confirm: "RUN",
      });
      seen.length = 0;
      await run(job.jobId, { embedder: counting });
      return { ...job, sha };
    };
    const b = await edit("second version", f.sha);
    expect(seen).toEqual(["second version"]);
    // The active (newest) candidate's file is gone: reuse must not end there.
    rmSync(generationFilePath(indexDir, f.kbId, b.generationId), { force: true });
    const c = await edit("third version", b.sha);
    expect(seen).toEqual(["third version"]);
    expect(await active(f.kbId)).toBe(c.generationId);
  });

  it("review #5: reuse walks past a newest file whose hash table is damaged", async () => {
    const large = Array.from({ length: 10_700 }, (_, i) => `word${i}`).join(" ");
    const f = await fixture({ "large.md": large, "other.md": "first version" });
    const a = await f.attach();
    const seen: string[] = [];
    const counting = {
      embed: async (texts: readonly string[]) => {
        seen.push(...texts);
        return texts.map((text) => [1 + (text.length % 7), 2]);
      },
    };
    await run(a.jobId, { embedder: counting });
    const edit = async (version: string, base: string) => {
      const sha = source(f.kbId, { "large.md": large, "other.md": version }, base);
      await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: sha } });
      const job = await requestIndexBuild(runtime, f.actor, {
        kbId: f.kbId,
        idempotencyKey: key(),
        confirm: "RUN",
      });
      seen.length = 0;
      await run(job.jobId, { embedder: counting });
      return { ...job, sha };
    };
    const b = await edit("second version", f.sha);
    // The newest (active) file's hash table page is damaged: reading it fails.
    const path = generationFilePath(indexDir, f.kbId, b.generationId);
    chmodSync(path, 0o600);
    const Database = loadSqlite();
    const probe = new Database(path, { readonly: true });
    const root = (
      probe.prepare("SELECT rootpage FROM sqlite_master WHERE name='chunk_hash'").get() as {
        rootpage: number;
      }
    ).rootpage;
    const pageSize = probe.pragma("page_size", { simple: true }) as number;
    probe.close();
    const bytes = readFileSync(path);
    bytes.fill(0xa5, (root - 1) * pageSize, root * pageSize);
    writeFileSync(path, bytes);
    const c = await edit("third version", b.sha);
    // Reused from `a` (the only usable file): only the changed document is embedded.
    expect(seen).toEqual(["third version"]);
    expect(await active(f.kbId)).toBe(c.generationId);
  });

  it("review r2 #2: a stored vector of another width is embedded again, never copied on", async () => {
    const large = Array.from({ length: 10_700 }, (_, i) => `word${i}`).join(" ");
    const f = await fixture({ "large.md": large, "other.md": "first version" });
    const a = await f.attach();
    const seen: string[] = [];
    const counting = {
      embed: async (texts: readonly string[]) => {
        seen.push(...texts);
        return texts.map((text) => [1 + (text.length % 7), 2]);
      },
    };
    await run(a.jobId, { embedder: counting });
    const path = generationFilePath(indexDir, f.kbId, a.generationId);
    chmodSync(path, 0o600);
    const Database = loadSqlite();
    const db = new Database(path);
    const { id, text } = db
      .prepare(
        "SELECT c.id AS id, c.text AS text FROM chunks c WHERE c.path='large.md' ORDER BY c.id LIMIT 1",
      )
      .get() as { id: number; text: string };
    db.prepare("UPDATE chunk_int8 SET e=substr(e,1,1) WHERE id=?").run(id);
    db.close();
    const sha = source(f.kbId, { "large.md": large, "other.md": "second version" }, f.sha);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: sha } });
    const b = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    seen.length = 0;
    await run(b.jobId, { embedder: counting });
    expect(seen.sort()).toEqual(["second version", text].sort());
    const next = new Database(generationFilePath(indexDir, f.kbId, b.generationId), {
      readonly: true,
    });
    const bad = next.prepare("SELECT count(*) AS n FROM chunk_int8 WHERE length(e)<>2").get() as {
      n: number;
    };
    next.close();
    expect(bad.n).toBe(0);
  });

  it("accounts empty and all-redacted source with zero embedding calls and zero rows", async () => {
    const f = await fixture({
      "empty.md": "",
      "redacted.md": `Authorization: Bearer ${"x".repeat(32)}`,
    });
    const a = await f.attach();
    const before = embedder.embed.mock.calls.length;
    await run(a.jobId);
    expect(embedder.embed.mock.calls.length).toBe(before);
    expect(await counts(a.generationId)).toBe(0);
    expect(readIndexFile(generationFilePath(indexDir, f.kbId, a.generationId)).documents).toEqual([
      expect.objectContaining({ path: "empty.md", state: "EMPTY" }),
      expect.objectContaining({ path: "redacted.md", state: "SKIPPED_REDACTED" }),
    ]);
    const docs = await prisma.generationDocument.findMany({
      where: { generationId: a.generationId },
      orderBy: { path: "asc" },
      take: 10,
    });
    expect(docs.map((d) => [d.path, d.state, d.retainedWindowCount])).toEqual([
      ["empty.md", "EMPTY", 0],
      ["redacted.md", "SKIPPED_REDACTED", 0],
    ]);
    expect(await active(f.kbId)).toBe(a.generationId);
  });

  it("keeps the previous active pointer on embedding failure; retries the same snapshot without duplicate chunks", async () => {
    const f = await fixture({
      "source.md": Array.from({ length: 11000 }, (_, i) => `word${i}`).join(" "),
    });
    const a = await f.attach();
    await run(a.jobId);
    // New text throughout, so the rebuild embeds every chunk (no reuse).
    const sha = source(
      f.kbId,
      { "source.md": Array.from({ length: 11000 }, (_, i) => `term${i}`).join(" ") },
      f.sha,
    );
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: sha } });
    const b = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    let calls = 0;
    await expect(
      run(b.jobId, {
        embedder: {
          embed: async (texts) => {
            if (++calls === 2) throw new Error("private provider failure");
            return texts.map(() => [0.6, 0.8]);
          },
        },
      }),
    ).rejects.toThrow("Index build failed");
    // Nothing of the failed attempt is published or left behind; its reservations are released.
    expect(await counts(b.generationId)).toBeNull();
    expect(filesOf(f.kbId, b.generationId)).toEqual([]);
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: b.generationId } }))
        .quotaReservationIds,
    ).toEqual([]);
    // Serve order: lexical@head (built first) serves the new head over the older hybrid.
    expect(await active(f.kbId)).toBe(await lexicalOf(f.kbId, sha));
    expect((await getIndexProfile(runtime, f.actor, f.kbId)).index.freshness).toBe("failed");
    const failed = await prisma.durableJob.findUniqueOrThrow({ where: { id: b.jobId } });
    expect(failed.lastError).not.toContain("private provider");
    await prisma.durableJob.update({ where: { id: b.jobId }, data: { state: "FAILED" } });
    await retryDurableJob(prisma, b.jobId);
    await run(b.jobId);
    expect(await counts(b.generationId)).toBe(await counts(a.generationId));
    expect(await active(f.kbId)).toBe(b.generationId);
    // Epoch 1: the first build's lexical companion; 2: its semantic build; 3: the new head's
    // lexical companion; 4: this rebuild.
    expect((await getIndexProfile(runtime, f.actor, f.kbId)).index.desiredEpoch).toBe("4");
  });

  it("rejects expired late writes and allows takeover only after the old build permit drains", async () => {
    const f = await fixture();
    const a = await f.attach();
    const paused = barrier();
    const pending = run(a.jobId, {
      embedder: {
        embed: async (texts) => {
          await paused.wait();
          return texts.map(() => [0.6, 0.8]);
        },
      },
    }).catch((e) => e);
    try {
      await paused.entered;
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { leaseUntil: new Date(0) } });
      await claimDispatchBatch(prisma, { owner: "recovery", now: new Date() });
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { nextRunAt: new Date(0) } });
      await publish();
      expect(
        await runIndexBuildDelivery(prisma, {
          connectionString: db.urls.runtime,
          reposDir,
          indexDir,
          masterKey,
          workerId: key(),
          durableJobId: a.jobId,
          embedder,
        }),
      ).toEqual({ skipped: true });
      expect(
        await heartbeatJobAttempt(prisma, {
          jobId: a.jobId,
          workerId:
            (await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).workerOwner ??
            "expired",
          attemptEpoch: 1,
          now: new Date(),
        }),
      ).toBe(false);
      paused.release();
      expect(await pending).toBeInstanceOf(Error);
      expect(await counts(a.generationId)).toBeNull();
      await run(a.jobId);
      expect(await active(f.kbId)).toBe(a.generationId);
      expect(await counts(a.generationId)).toBe(1);
      expect(
        (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } })).attempt,
      ).toBe(2);
    } finally {
      paused.release();
      await pending;
    }
  });

  it("provider revoke serves the active file lexically, schedules a lexical generation and cancels a paused newer result", async () => {
    const f = await fixture();
    const a = await f.attach();
    await run(a.jobId);
    const b = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    const paused = barrier();
    const pending = run(b.jobId, { beforeActivation: paused.wait }).catch((e) => e);
    try {
      await paused.entered;
      await revokeProvider(runtime, f.user.id, { providerId: f.p.providerId });
      paused.release();
      expect(await pending).toBeInstanceOf(Error);
      expect(await active(f.kbId)).toBe(a.generationId);
      const { index } = await getIndexProfile(runtime, f.actor, f.kbId);
      // The revoked file keeps serving its FTS5 arm while the lexical generation builds (L-7).
      expect(index).toMatchObject({ activeGenerationId: a.generationId, freshness: "building" });
      const desired = await prisma.indexGeneration.findUniqueOrThrow({
        where: { id: index.desiredGenerationId! },
      });
      expect(desired).toMatchObject({ providerId: null, fingerprint: null, state: "PENDING" });
      expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: b.jobId } })).state).toBe(
        "CANCELLED",
      );
    } finally {
      paused.release();
      await pending;
    }
  });

  it("main finalize enqueues once across journal replay, while proposal/noop do not enqueue", async () => {
    const f = await fixture();
    await f.attach();
    for (const updatesMain of [false, true]) {
      const opId = randomUUID();
      const head = source(f.kbId, { "source.md": `journal ${updatesMain}` }, f.sha);
      await prisma.operationIntent.create({
        data: {
          opId,
          kbId: f.kbId,
          actorKey: `user:${f.user.id}`,
          actorUserIdSnapshot: f.user.id,
          actorUserId: f.user.id,
          operation: "CHANGES_APPLY",
          idempotencyKey: key(),
          requestHash: "a".repeat(64),
          publishNonce: key(),
          phase: "COMMITTING",
          preparedDelta: {
            kind: "changes_apply",
            headSha: head,
            baseRevision: f.sha,
            resultKind: updatesMain ? "applied" : "proposed",
            changedPaths: ["source.md"],
            sourceSessionIds: [],
            targetRef: updatesMain ? "refs/heads/main" : "refs/heads/proposal",
            updatesMain,
            proposalNumber: null,
            proposalTitle: null,
            proposalVersion: null,
            isAutoPr: false,
            branchBaseSha: null,
            quotaReservationIds: [],
          },
        },
      });
      const before = await prisma.indexGeneration.count({ where: { kbId: f.kbId } });
      const first = await transaction((q) => finalizeIntent(q, opId));
      const replay = await transaction((q) => finalizeIntent(q, opId));
      expect(replay.responseBody).toEqual(first.responseBody);
      // Nothing serves the head yet (the attached build never ran): a main commit schedules
      // its lexical companion and the semantic build.
      expect(await prisma.indexGeneration.count({ where: { kbId: f.kbId } })).toBe(
        before + (updatesMain ? 2 : 0),
      );
      expect(first.responseBody).toMatchObject({
        indexJobId: updatesMain ? expect.any(String) : null,
      });
    }
  });

  it("R3-W9: while nothing is active, a finished build of an older commit serves until the head's replaces it", async () => {
    const f = await fixture({ "a.md": "first" });
    const first = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    const next = source(f.kbId, { "a.md": "second" }, f.sha);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: next } });
    const second = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    expect(await run(first!.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(first!.generationId);
    expect(await run(second!.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(second!.generationId);
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: first!.generationId } }))
        .state,
    ).toBe("SUPERSEDED");
    // A serves, the head moves on to C and the intermediate B finishes
    // first: B, the newest older generation, replaces A.
    const third = source(f.kbId, { "a.md": "third" }, next);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: third } });
    const b = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    const fourth = source(f.kbId, { "a.md": "fourth" }, third);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: fourth } });
    const c = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    expect(await run(b!.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(b!.generationId);
    // The head moves again before C finishes: C, now the newest older, replaces B.
    const fifth = source(f.kbId, { "a.md": "fifth" }, fourth);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: fifth } });
    const d = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    expect(await run(c!.jobId)).toBe("COMPLETE");
    expect(await active(f.kbId)).toBe(c!.generationId);
    // A failed head build leaves the newest older fallback serving.
    await expect(
      run(d!.jobId, {
        afterPass1: async () => {
          throw new Error("injected head build failure");
        },
      }),
    ).rejects.toThrow("Index build failed");
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: d!.generationId } })).state,
    ).toBe("FAILED");
    expect(await active(f.kbId)).toBe(c!.generationId);
  });

  it("R3-L12: re-attaching the serving or building semantic profile starts nothing; a lexical one never counts", async () => {
    const f = await fixture();
    const generations = () => prisma.indexGeneration.count({ where: { kbId: f.kbId } });
    // Only lexical serves: attaching builds the semantic generation.
    const lexical = await transaction((q) => scheduleIndexBuild(q, f.kbId));
    expect(await run(lexical!.jobId)).toBe("COMPLETE");
    const a = await f.attach();
    expect(a.state).toBe("PENDING");
    // In flight: the same generation, no new work.
    const before = await generations();
    const building = await f.attach();
    expect(building).toMatchObject({
      state: "PENDING",
      generationId: a.generationId,
      jobId: a.jobId,
    });
    expect(await generations()).toBe(before);
    expect(await run(a.jobId)).toBe("COMPLETE");
    const current = await f.attach();
    expect(current).toMatchObject({ state: "CURRENT", generationId: a.generationId });
    expect(await generations()).toBe(before);
    // A new head: lexical@head may serve it, but the semantic profile is not current.
    const next = source(f.kbId, { "source.md": "changed" }, f.sha);
    await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: next } });
    const fresh = await f.attach();
    expect(fresh.state).toBe("PENDING");
    expect(fresh.generationId).not.toBe(a.generationId);
  });

  it("profile_set classifies unknown providers, never-existing and obsolete revisions", async () => {
    const f = await fixture();
    const set = (providerId: string, revision?: number) =>
      requestIndexBuild(runtime, f.actor, {
        kbId: f.kbId,
        providerId,
        ...(revision === undefined ? {} : { revision }),
        idempotencyKey: key(),
        confirm: "RUN",
      });
    await expect(set("z".repeat(24), 1)).rejects.toMatchObject({ code: "NOT_FOUND", details: {} });
    await expect(set(f.p.providerId, 99)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "REVISION_NOT_CURRENT", field: "/revision" },
    });
    await expect(set(f.p.providerId)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "MISSING_ARGUMENT", field: "/revision" },
    });
  });

  it("rolls back profile attachment on failed enqueue and denies foreign providers/read-only users", async () => {
    const f = await fixture();
    const foreign = await owner();
    const p = await provider(foreign.id);
    await expect(
      requestIndexBuild(runtime, f.actor, {
        kbId: f.kbId,
        providerId: p.providerId,
        revision: 1,
        idempotencyKey: key(),
        confirm: "RUN",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: {} });
    await prisma.kbShare.create({ data: { kbId: f.kbId, userId: foreign.id, bits: ["read"] } });
    await expect(
      requestIndexBuild(
        runtime,
        { principal: { kind: "browser", userId: foreign.id } },
        { kbId: f.kbId, idempotencyKey: key(), confirm: "RUN" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const broken: KbRuntimeConfig = {
      ...runtime,
      coordinator: {
        run: (options) =>
          runtime.coordinator.run({
            ...options,
            run: async (ctx) => {
              const original = ctx.lease.transaction.bind(ctx.lease);
              ctx.lease.transaction = <T>(work: (q: LockQuery) => Promise<T>) =>
                original((q) =>
                  work((async (sql, values) => {
                    if (sql.includes('INSERT INTO "durable_job"'))
                      throw new Error("injected enqueue failure");
                    return q(sql, values);
                  }) as LockQuery),
                );
              try {
                return await options.run(ctx);
              } finally {
                ctx.lease.transaction = original;
              }
            },
          }),
      },
    };
    await expect(
      requestIndexBuild(broken, f.actor, {
        kbId: f.kbId,
        providerId: f.p.providerId,
        revision: 1,
        idempotencyKey: key(),
        confirm: "RUN",
      }),
    ).rejects.toThrow("enqueue");
    expect(
      (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).profileProviderId,
    ).toBeNull();
    expect(await prisma.indexGeneration.count({ where: { kbId: f.kbId } })).toBe(0);
  });

  it("cancels through lifecycle and never activates a tombstoned KB", async () => {
    const f = await fixture();
    const a = await f.attach();
    const paused = barrier();
    const pending = run(a.jobId, { beforeActivation: paused.wait }).catch((e) => e);
    try {
      await paused.entered;
      await transaction(async (q) => {
        await q("UPDATE knowledge_base SET state='TOMBSTONED' WHERE id=$1", [f.kbId]);
        await runAccountTeardown(q, f.kbId, f.user.id, randomUUID());
      });
      paused.release();
      expect(await pending).toBeInstanceOf(Error);
      expect(await semanticActive(f.kbId)).toBeNull();
    } finally {
      paused.release();
      await pending;
    }
  });
  it("takes over after a published file and rejects the expired CAS on the same generation", async () => {
    const f = await fixture();
    const a = await f.attach();
    const gate = barrier();
    const old = run(a.jobId, { beforeActivation: gate.wait }).catch((e) => e);
    try {
      await gate.entered;
      const job = await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } });
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { leaseUntil: new Date(0) } });
      expect(
        await heartbeatJobAttempt(prisma, {
          jobId: a.jobId,
          workerId: job.workerOwner!,
          attemptEpoch: 1,
          now: new Date(),
        }),
      ).toBe(false);
      await claimDispatchBatch(prisma, { owner: "takeover", now: new Date() });
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { nextRunAt: new Date(0) } });
      await run(a.jobId);
      gate.release();
      expect(await old).toBeInstanceOf(Error);
      expect(await active(f.kbId)).toBe(a.generationId);
      expect(await counts(a.generationId)).toBe(1);
      // The takeover's reset unlinked attempt 1's published file and published its own.
      expect(
        (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } })).attempt,
      ).toBe(2);
      expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.sqlite`]);
    } finally {
      gate.release();
      await old;
    }
  });

  it("allows two actual builds globally, one per KB, and releases capacity after completion", async () => {
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    const builds = [];
    for (const f of fixtures) builds.push(await f.attach());
    const first = barrier();
    const second = barrier();
    const a = run(builds[0]!.jobId, { afterChunks: first.wait });
    await first.entered;
    const b = run(builds[1]!.jobId, { afterChunks: second.wait });
    try {
      await second.entered;
      expect(await run(builds[0]!.jobId, {}, { skipped: true })).toEqual({ skipped: true });
      expect(await run(builds[2]!.jobId, {}, { skipped: true })).toEqual({ skipped: true });
      first.release();
      await a;
      second.release();
      await b;
      await run(builds[2]!.jobId);
      expect(await active(fixtures[2]!.kbId)).toBe(builds[2]!.generationId);
    } finally {
      first.release();
      second.release();
      await Promise.allSettled([a, b]);
    }
  });

  it("transfer registry cancels old work and detaches a foreign profile without reusing its vectors", async () => {
    const f = await fixture();
    const a = await f.attach();
    await run(a.jobId);
    const pending = await requestIndexBuild(runtime, f.actor, {
      kbId: f.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    const next = await owner();
    await transaction(async (query) => {
      await query('UPDATE knowledge_base SET "ownerId"=$2 WHERE id=$1', [f.kbId, next.id]);
      for (const handler of listTransferLifecycleHandlersForTests())
        await handler({ query, kbId: f.kbId, fromUserId: f.user.id, toUserId: next.id });
    });
    const kb = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } });
    expect(kb.profileProviderId).toBeNull();
    expect(kb.activeGenerationId).toBeNull();
    // The detached completion can never serve again: it is superseded in the same transaction.
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } })).state,
    ).toBe("SUPERSEDED");
    // The first build's lexical companion took one more epoch.
    expect(kb.desiredEpoch).toBe(4n);
    expect(
      (await prisma.durableJob.findUniqueOrThrow({ where: { id: pending.jobId } })).state,
    ).toBe("CANCELLED");
    expect(
      (await getIndexProfile(runtime, { principal: { kind: "browser", userId: next.id } }, f.kbId))
        .index.freshness,
      // Without the foreign profile the new owner gets a lexical-only build.
    ).toBe("building");
  });
});

describe("index files, disk reservations and cancellation (P4)", () => {
  const reserved = async () =>
    (
      await db.query(
        "runtime",
        `SELECT COALESCE(sum(reserved),0)::text AS n FROM quota_account WHERE dimension='DISK_VOLUME'`,
      )
    ).rows[0]?.n as string;
  const generation = (generationId: string) =>
    prisma.indexGeneration.findUniqueOrThrow({ where: { id: generationId } });
  const outcomes = async (ids: string[]) =>
    (
      await db.query(
        "runtime",
        `SELECT outcome::text AS o FROM quota_reservation WHERE id = ANY($1::text[]) ORDER BY id`,
        [ids],
      )
    ).rows.map((row) => row.o as string);

  it.each([
    ["full", 4096, 2048],
    ["final partial", 4099, 4098],
  ] as const)(
    "keeps the active generation and releases reservations after a %s flush fails",
    async (_, count, failId) => {
      const f = await fixture();
      const a = await f.attach();
      await run(a.jobId);
      const previousPath = generationFilePath(indexDir, f.kbId, a.generationId);
      const previousBytes = readFileSync(previousPath);
      const files = Object.fromEntries(
        Array.from({ length: 41 }, (_, i) => [
          `d${String(i).padStart(2, "0")}.md`,
          "x ".repeat(400 + (Math.min(100, count - i * 100) - 1) * 320),
        ]),
      );
      const sha = source(f.kbId, files, f.sha);
      await prisma.knowledgeBase.update({ where: { id: f.kbId }, data: { headSha: sha } });
      const b = await requestIndexBuild(runtime, f.actor, {
        kbId: f.kbId,
        idempotencyKey: key(),
        confirm: "RUN",
      });
      const before = await reserved();
      let held: string[] = [];
      const diagnostic = captureLog();
      try {
        await expect(
          run(b.jobId, {
            afterPass1: async () => {
              const row = await generation(b.generationId);
              expect(row.chunkCount).toBe(count);
              held = row.quotaReservationIds;
              expect(held.length).toBeGreaterThan(0);
              expect(await outcomes(held)).toEqual(held.map(() => "RESERVED"));
              const Database = loadSqlite();
              const sqlite = new Database(join(indexDir, f.kbId, `${b.generationId}.a1.tmp`), {
                fileMustExist: true,
              });
              try {
                // This only raises after all bits and part of int8 have been inserted.
                sqlite.exec(`CREATE TRIGGER fail_grouped_flush BEFORE INSERT ON chunk_int8
            WHEN new.id=${failId} AND (SELECT count(*) FROM chunk_bits)=${count}
              AND (SELECT count(*) FROM chunk_int8)=${failId - 1}
            BEGIN SELECT RAISE(ABORT, 'injected grouped flush failure'); END`);
              } finally {
                sqlite.close();
              }
            },
          }),
        ).rejects.toThrow("Index build failed");
        expect(diagnostic.records).toContainEqual(
          expect.objectContaining({
            site: "kb.index-build",
            code: "INDEX_BUILD_FAILED",
            errorClass: "SqliteError",
          }),
        );
      } finally {
        diagnostic.restore();
      }
      expect(held.length).toBeGreaterThan(0);
      // lexical@head serves the new head; the older hybrid's file is untouched.
      expect(await active(f.kbId)).toBe(await lexicalOf(f.kbId, sha));
      expect(readFileSync(previousPath)).toEqual(previousBytes);
      expect((await generation(b.generationId)).state).toBe("FAILED");
      expect((await generation(b.generationId)).quotaReservationIds).toEqual([]);
      expect(await outcomes(held)).toEqual(held.map(() => "RELEASED"));
      expect(await reserved()).toBe(before);
      expect(filesOf(f.kbId, b.generationId)).toEqual([]);
      expect(await counts(b.generationId)).toBeNull();
    },
    120_000,
  );

  it("holds reservations only while BUILDING and releases them all at publish, even after expiry", async () => {
    const f = await fixture({ "a.md": "alpha one", "b.md": "beta two", "c.md": "gamma three" });
    const a = await f.attach();
    const before = await reserved();
    let held: string[] = [];
    const embedded: string[] = [];
    await run(a.jobId, {
      embedder: {
        embed: async (texts) => {
          embedded.push(...texts);
          return texts.map(() => [0.6, 0.8]);
        },
      },
      afterChunks: async () => {
        const row = await generation(a.generationId);
        expect(row.state).toBe("BUILDING");
        held = row.quotaReservationIds;
        // The pass-1 text estimate covers this small corpus: no top-up was needed.
        expect(held.length).toBeGreaterThanOrEqual(1);
        expect(await outcomes(held)).toEqual(held.map(() => "RESERVED"));
        expect(await reserved()).not.toBe(before);
        // Reservations are only ever released, so an expired one still publishes.
        await db.query(
          "runtime",
          `UPDATE quota_reservation SET "expiresAt"=now()-interval '1 second' WHERE id = ANY($1::text[])`,
          [held],
        );
      },
    });
    expect(await active(f.kbId)).toBe(a.generationId);
    expect((await generation(a.generationId)).quotaReservationIds).toEqual([]);
    expect(await outcomes(held)).toEqual(held.map(() => "RELEASED"));
    expect(await reserved()).toBe(before);
    // Each chunk is embedded exactly once (the int8 calibration sample is reused).
    expect(embedded.sort()).toEqual(["alpha one", "beta two", "gamma three"]);
  });

  it("guards: no reservation outside BUILDING (I1), no cancel over an unreleased one (I2)", async () => {
    const f = await fixture();
    const a = await f.attach();
    const paused = barrier();
    const pending = run(a.jobId, { afterChunks: paused.wait }).catch((e: unknown) => e);
    try {
      await paused.entered;
      const ids = (await generation(a.generationId)).quotaReservationIds;
      expect(ids.length).toBeGreaterThan(0);
      await expect(
        db.query("applier", `UPDATE durable_job SET state='CANCELLED' WHERE id=$1`, [a.jobId]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(cancelDurableJob(prisma, a.jobId)).rejects.toThrow();
      await expect(
        db.query("applier", `UPDATE index_generation SET state='FAILED' WHERE id=$1`, [
          a.generationId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).state).toBe(
        "RUNNING",
      );
      // The only canceller releases first, then cancels without writing the generation.
      await transaction((q) => cancelIndexBuildJobs(q, { kbId: f.kbId }));
      expect(await outcomes(ids)).toEqual(ids.map(() => "RELEASED"));
      expect((await generation(a.generationId)).quotaReservationIds).toEqual(ids);
      expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).state).toBe(
        "CANCELLED",
      );
    } finally {
      paused.release();
    }
    // The resumed worker fails its fence at publish and creates no new reservation.
    expect(await pending).toBeInstanceOf(Error);
    expect(await semanticActive(f.kbId)).toBeNull();
    const after = await generation(a.generationId);
    expect(after.state).toBe("BUILDING");
    expect((await outcomes(after.quotaReservationIds)).every((o) => o === "RELEASED")).toBe(true);
    expect(filesOf(f.kbId, a.generationId)).toEqual([]);
  });

  it.each(["transfer", "account removal"] as const)(
    "cancellation through %s releases a paused build's reservations",
    async (path) => {
      const f = await fixture();
      const a = await f.attach();
      const before = await reserved();
      const paused = barrier();
      const pending = run(a.jobId, { afterChunks: paused.wait }).catch((e: unknown) => e);
      try {
        await paused.entered;
        const ids = (await generation(a.generationId)).quotaReservationIds;
        if (path === "transfer") {
          const next = await owner();
          await transaction(async (query) => {
            await query('UPDATE knowledge_base SET "ownerId"=$2 WHERE id=$1', [f.kbId, next.id]);
            for (const handler of listTransferLifecycleHandlersForTests())
              await handler({ query, kbId: f.kbId, fromUserId: f.user.id, toUserId: next.id });
          });
        } else {
          await transaction(async (q) => {
            await q("UPDATE knowledge_base SET state='TOMBSTONED' WHERE id=$1", [f.kbId]);
            await runAccountTeardown(q, f.kbId, f.user.id, randomUUID());
          });
        }
        expect(await outcomes(ids)).toEqual(ids.map(() => "RELEASED"));
        expect(await reserved()).toBe(before);
        expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).state).toBe(
          "CANCELLED",
        );
      } finally {
        paused.release();
      }
      expect(await pending).toBeInstanceOf(Error);
      expect(await reserved()).toBe(before);
    },
  );

  it.each(["INT8", "BINARY_INT8_RESCORE"] as const)(
    "fails INDEX_CHUNK_LIMIT_EXCEEDED before embeddings using the %s ceiling",
    async (quantization) => {
      const f = await fixture({ "a.md": "one", "b.md": "two", "c.md": "three" });
      await prisma.knowledgeBase.update({
        where: { id: f.kbId },
        data: { indexChunkLimit: 10, indexQuantization: quantization },
      });
      const ceilingKey = `kb.index.chunkCeiling.${quantization.toLowerCase()}`;
      await prisma.appSetting.upsert({
        where: { key: ceilingKey },
        create: { key: ceilingKey, value: "2" },
        update: { value: "2" },
      });
      try {
        const a = await f.attach();
        const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.6, 0.8]));
        await expect(run(a.jobId, { embedder: { embed } })).rejects.toThrow("Index build failed");
        expect(embed).not.toHaveBeenCalled();
        expect(await generation(a.generationId)).toMatchObject({
          state: "FAILED",
          errorCode: "INDEX_CHUNK_LIMIT_EXCEEDED",
          quotaReservationIds: [],
        });
        expect(filesOf(f.kbId, a.generationId)).toEqual([]);
        // kb/1 keeps its single public failure code.
        expect((await getIndexProfile(runtime, f.actor, f.kbId)).index).toMatchObject({
          freshness: "failed",
        });
      } finally {
        await prisma.appSetting.delete({
          where: { key: ceilingKey },
        });
      }
    },
  );

  it("refused disk admission fails INDEX_DISK_FULL and leaves nothing behind", async () => {
    const f = await fixture();
    const a = await f.attach();
    await expect(
      run(a.jobId, { initialTextReservationBytes: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow("Index build failed");
    expect(await generation(a.generationId)).toMatchObject({
      state: "FAILED",
      errorCode: "INDEX_DISK_FULL",
      quotaReservationIds: [],
    });
    expect(filesOf(f.kbId, a.generationId)).toEqual([]);
  });

  it("a takeover's reset unlinks the crashed attempt's temp and journal and releases its reservations", async () => {
    const f = await fixture();
    const a = await f.attach();
    const before = await reserved();
    const paused = barrier();
    const old = run(a.jobId, { afterPass1: paused.wait }).catch((e: unknown) => e);
    try {
      await paused.entered;
      const crashedIds = (await generation(a.generationId)).quotaReservationIds;
      expect(crashedIds.length).toBeGreaterThan(0);
      writeFileSync(join(indexDir, f.kbId, `${a.generationId}.a1.tmp-journal`), "stale");
      expect(filesOf(f.kbId, a.generationId).sort()).toEqual([
        `${a.generationId}.a1.tmp`,
        `${a.generationId}.a1.tmp-journal`,
      ]);
      // The worker "crashed": its session (and with it every build permit) is gone, its lease
      // expires and dispatch recovery re-runs the job.
      await db.query(
        "runtime",
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
            AND l.classid=((hashtextextended($1,24)>>32)&4294967295)::oid
            AND l.objid=(hashtextextended($1,24)&4294967295)::oid`,
        [f.kbId],
      );
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { leaseUntil: new Date(0) } });
      await claimDispatchBatch(prisma, { owner: "recovery", now: new Date() });
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { nextRunAt: new Date(0) } });
      expect(await run(a.jobId)).toBe("COMPLETE");
      expect(await outcomes(crashedIds)).toEqual(crashedIds.map(() => "RELEASED"));
      expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.sqlite`]);
      expect(await reserved()).toBe(before);
    } finally {
      paused.release();
    }
    expect(await old).toBeInstanceOf(Error);
    expect(await active(f.kbId)).toBe(a.generationId);
    expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.sqlite`]);
  });

  it("R5 exhausted lease recovery fails the generation with its job; re-attaching schedules a replacement", async () => {
    const f = await fixture();
    const a = await f.attach();
    const before = await reserved();
    const paused = barrier();
    const old = run(a.jobId, { afterPass1: paused.wait }).catch((e: unknown) => e);
    try {
      await paused.entered;
      const crashedIds = (await generation(a.generationId)).quotaReservationIds;
      expect(crashedIds.length).toBeGreaterThan(0);
      // The worker crashed on its last allowed attempt: its permits go with its
      // session, its lease expires and recovery exhausts the retry budget.
      await db.query(
        "runtime",
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
            AND l.classid=((hashtextextended($1,24)>>32)&4294967295)::oid
            AND l.objid=(hashtextextended($1,24)&4294967295)::oid`,
        [f.kbId],
      );
      await prisma.durableJob.update({
        where: { id: a.jobId },
        data: { leaseUntil: new Date(0), attemptCount: MAX_DURABLE_RETRY_ATTEMPTS },
      });
      await claimDispatchBatch(prisma, { owner: "recovery", now: new Date() });
      // One transaction: the job and its generation are terminal together.
      expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).state).toBe(
        "FAILED",
      );
      expect(await generation(a.generationId)).toMatchObject({
        state: "FAILED",
        errorCode: "INDEX_BUILD_FAILED",
        quotaReservationIds: [],
      });
      expect(await outcomes(crashedIds)).toEqual(crashedIds.map(() => "RELEASED"));
      expect(await reserved()).toBe(before);
    } finally {
      paused.release();
    }
    expect(await old).toBeInstanceOf(Error);
    // The dead build is no pending work: re-attaching schedules its replacement.
    const again = await f.attach();
    expect(again.state).toBe("PENDING");
    expect(again.generationId).not.toBe(a.generationId);
    expect(await run(again.jobId)).toBe("COMPLETE");
    expect(await semanticActive(f.kbId)).toBe(again.generationId);
  });

  it("R6 one expired lease whose recovery fails stays RUNNING alone, deferred; the rest of the batch dispatches", async () => {
    const f = await fixture();
    const a = await f.attach();
    const other = await (await fixture()).attach();
    const paused = barrier();
    const old = run(a.jobId, { afterPass1: paused.wait }).catch((e: unknown) => e);
    let restore: Array<{ id: string; reserved: string }> = [];
    try {
      await paused.entered;
      const crashedIds = (await generation(a.generationId)).quotaReservationIds;
      expect(crashedIds.length).toBeGreaterThan(0);
      await db.query(
        "runtime",
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
            AND l.classid=((hashtextextended($1,24)>>32)&4294967295)::oid
            AND l.objid=(hashtextextended($1,24)&4294967295)::oid`,
        [f.kbId],
      );
      await prisma.durableJob.update({
        where: { id: a.jobId },
        // Sorted ahead of every other due row.
        data: {
          leaseUntil: new Date(0),
          nextRunAt: new Date(0),
          attemptCount: MAX_DURABLE_RETRY_ATTEMPTS,
        },
      });
      // Inconsistent reservation accounting: the volume account no longer
      // holds what the generation reserved, so its release throws.
      restore = (
        await db.query(
          "runtime",
          `SELECT a.id, a.reserved::text AS reserved FROM quota_account a
            WHERE a.id IN (SELECT "accountId" FROM quota_reservation WHERE id = ANY($1::text[]))`,
          [crashedIds],
        )
      ).rows as Array<{ id: string; reserved: string }>;
      await db.query(
        "runtime",
        "UPDATE quota_account SET reserved = 0 WHERE id = ANY($1::text[])",
        [restore.map((row) => row.id)],
      );
      const now = new Date();
      const claimed = await claimDispatchBatch(prisma, { owner: "recovery", now });
      // The other due job is still claimed for dispatch.
      expect(claimed.map((row) => row.id)).toContain(other.jobId);
      // The failed recovery rolled back alone: job, generation and reservations
      // unchanged, and the row is deferred one claim window.
      expect(await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).toMatchObject({
        state: "RUNNING",
        dispatchOwner: null,
        dispatchClaimUntil: new Date(now.getTime() + DISPATCH_CLAIM_MS),
      });
      expect(await generation(a.generationId)).toMatchObject({
        state: expect.not.stringMatching(/^FAILED$/),
        quotaReservationIds: crashedIds,
      });
      expect(await outcomes(crashedIds)).toEqual(crashedIds.map(() => "RESERVED"));
      await releaseDispatchClaim(prisma, { jobId: other.jobId, owner: "recovery" });
      // Failing rows never fill a batch: with room for one row only, the
      // healthy job is the one claimed while the failing row is deferred.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const single = await claimDispatchBatch(prisma, { owner: "recovery", now, limit: 1 });
        expect(single.map((row) => row.id)).toEqual([other.jobId]);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
      await releaseDispatchClaim(prisma, { jobId: other.jobId, owner: "recovery" });
      // Once the accounting is consistent again, the first pass after the
      // deferral recovers it.
      for (const row of restore)
        await db.query("runtime", "UPDATE quota_account SET reserved = $2::bigint WHERE id = $1", [
          row.id,
          row.reserved,
        ]);
      restore = [];
      await claimDispatchBatch(prisma, {
        owner: "recovery",
        now: new Date(now.getTime() + DISPATCH_CLAIM_MS + 1),
      });
      expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: a.jobId } })).state).toBe(
        "FAILED",
      );
      expect(await generation(a.generationId)).toMatchObject({
        state: "FAILED",
        quotaReservationIds: [],
      });
      expect(await outcomes(crashedIds)).toEqual(crashedIds.map(() => "RELEASED"));
    } finally {
      for (const row of restore)
        await db.query("runtime", "UPDATE quota_account SET reserved = $2::bigint WHERE id = $1", [
          row.id,
          row.reserved,
        ]);
      paused.release();
    }
    expect(await old).toBeInstanceOf(Error);
  });

  it("R5 a generation whose job is terminal is never pending work, and the backstop settles it", async () => {
    const f = await fixture();
    const a = await f.attach();
    // A canceller never writes the generation: it still reads PENDING.
    expect(await cancelDurableJob(prisma, a.jobId)).toBe(true);
    expect((await generation(a.generationId)).state).toBe("PENDING");
    const again = await f.attach();
    expect(again.state).toBe("PENDING");
    expect(again.generationId).not.toBe(a.generationId);
    await releaseStaleBuildReservations({ connectionString: db.urls.runtime });
    expect(await generation(a.generationId)).toMatchObject({
      state: "FAILED",
      errorCode: "INDEX_BUILD_CANCELLED",
    });
  });

  it("a failure after link (before INDEXING) is retried; the next reset unlinks the stale final", async () => {
    const f = await fixture();
    const a = await f.attach();
    await expect(
      run(a.jobId, {
        afterLink: async () => {
          throw new Error("crash after link");
        },
      }),
    ).rejects.toThrow("Index build failed");
    // The publish transaction rolled back; the linked final outlives it.
    expect(await generation(a.generationId)).toMatchObject({
      state: "FAILED",
      quotaReservationIds: [],
    });
    expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.sqlite`]);
    await prisma.durableJob.update({ where: { id: a.jobId }, data: { state: "FAILED" } });
    await retryDurableJob(prisma, a.jobId);
    expect(await run(a.jobId)).toBe("COMPLETE");
    expect(await counts(a.generationId)).toBe(1);
    expect((await generation(a.generationId)).attempt).toBeGreaterThan(1);
  });
});

describe("cancellation matrix, disk admission and attempt ownership (P4)", () => {
  type Canceller = "transfer" | "account removal" | "provider revoke";
  const reserved = async () =>
    (
      await db.query(
        "runtime",
        `SELECT COALESCE(sum(reserved),0)::text AS n FROM quota_account WHERE dimension='DISK_VOLUME'`,
      )
    ).rows[0]?.n as string;
  /** Every reservation any attempt of the generation ever created, with its outcome. */
  const reservationsOf = async (generationId: string) =>
    (
      await db.query(
        "runtime",
        `SELECT id, outcome::text AS outcome, amount::text AS amount FROM quota_reservation
          WHERE "opId" LIKE $1 ORDER BY "createdAt", id`,
        [`index-build:${generationId}:%`],
      )
    ).rows as Array<{ id: string; outcome: string; amount: string }>;
  const jobState = async (jobId: string) =>
    (await prisma.durableJob.findUniqueOrThrow({ where: { id: jobId } })).state;
  async function cancelThrough(path: Canceller, f: Awaited<ReturnType<typeof fixture>>) {
    if (path === "transfer") {
      const next = await owner();
      await transaction(async (query) => {
        await query('UPDATE knowledge_base SET "ownerId"=$2 WHERE id=$1', [f.kbId, next.id]);
        for (const handler of listTransferLifecycleHandlersForTests())
          await handler({ query, kbId: f.kbId, fromUserId: f.user.id, toUserId: next.id });
      });
    } else if (path === "account removal")
      await transaction(async (q) => {
        await q("UPDATE knowledge_base SET state='TOMBSTONED' WHERE id=$1", [f.kbId]);
        await runAccountTeardown(q, f.kbId, f.user.id, randomUUID());
      });
    else await revokeProvider(runtime, f.user.id, { providerId: f.p.providerId });
  }
  const once = (hook: () => Promise<void>) => {
    let used = false;
    return async () => {
      if (used) return;
      used = true;
      await hook();
    };
  };

  // P4 step 9 cancel-lock matrix for the three cancellers this suite can drive (retarget and
  // settleLease run in the qwen-reembed suite). The worker pauses INSIDE its fenced reservation
  // transaction (holding AUTH) or just before it.
  //  (i)  the canceller queues on AUTH, the reservation commits, then it is released and cancelled;
  //  (i') the pause outlasts the canceller's AUTH budget: LOCK_TIMEOUT, no effect; a retry after
  //       the reservation committed succeeds;
  //  (ii) the canceller runs first: the worker's fenced reserve fails, nothing is reserved.
  const cancellers = ["transfer", "account removal", "provider revoke"] as const;
  const cases = ["i", "i-prime", "ii"] as const;
  it.each(cancellers.flatMap((path) => cases.map((kase) => [path, kase] as const)))(
    "cancel-lock via %s, case (%s)",
    async (path, kase) => {
      const f = await fixture();
      const a = await f.attach();
      const before = await reserved();
      if (kase === "ii") {
        const gate = barrier();
        const pending = run(a.jobId, { beforeReserve: once(gate.wait) }).catch((e: unknown) => e);
        try {
          await gate.entered;
          await cancelThrough(path, f);
          expect(await jobState(a.jobId)).toBe("CANCELLED");
        } finally {
          gate.release();
        }
        expect(await pending).toBeInstanceOf(Error);
        expect(await reservationsOf(a.generationId)).toEqual([]);
        expect(await reserved()).toBe(before);
        return;
      }
      const inside = barrier();
      const afterPass1 = barrier();
      const pending = run(a.jobId, {
        afterReserve: once(inside.wait),
        afterPass1: afterPass1.wait,
      }).catch((e: unknown) => e);
      try {
        await inside.entered;
        if (kase === "i") {
          const cancelling = cancelThrough(path, f);
          await new Promise((r) => setTimeout(r, 300));
          expect(await jobState(a.jobId)).toBe("RUNNING");
          inside.release();
          await cancelling;
        } else {
          // The production canceller times out on AUTH and rolls back completely.
          await expect(cancelThrough(path, f)).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
          expect(await jobState(a.jobId)).toBe("RUNNING");
          expect(await reservationsOf(a.generationId)).toEqual([]);
          inside.release();
          await afterPass1.entered;
          expect((await reservationsOf(a.generationId)).map((r) => r.outcome)).toContain(
            "RESERVED",
          );
          // A retry succeeds and releases what the worker committed.
          await cancelThrough(path, f);
        }
        expect(await jobState(a.jobId)).toBe("CANCELLED");
      } finally {
        inside.release();
        afterPass1.release();
      }
      expect(await pending).toBeInstanceOf(Error);
      const rows = await reservationsOf(a.generationId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.outcome === "RELEASED")).toBe(true);
      // No reservation was created after the cancel: the resumed worker failed its fence.
      expect(await reservationsOf(a.generationId)).toHaveLength(rows.length);
      expect(await reserved()).toBe(before);
      expect(await semanticActive(f.kbId)).toBeNull();
    },
    30_000,
  );

  it("cancel-lock (iii): a backstop pass skips a stale row whose volume account a live fenced reserve holds, then clears it", async () => {
    // A committed stale generation: its build holds reservations, then its job fails.
    const g = await fixture();
    const stale = await g.attach();
    const parked = barrier();
    const staleRun = run(stale.jobId, { afterChunks: parked.wait }).catch((e: unknown) => e);
    await parked.entered;
    const staleIds = (await reservationsOf(stale.generationId)).map((r) => r.id);
    expect(staleIds.length).toBeGreaterThan(0);
    await prisma.durableJob.update({ where: { id: stale.jobId }, data: { state: "FAILED" } });
    // A live build pauses inside its fenced reserve, holding the shared volume account.
    const f = await fixture();
    const a = await f.attach();
    const inside = barrier();
    const pending = run(a.jobId, { afterReserve: once(inside.wait) });
    try {
      await inside.entered;
      const started = Date.now();
      await releaseStaleBuildReservations({ connectionString: db.urls.runtime });
      expect(Date.now() - started).toBeLessThan(5_000);
      // Skipped, untouched: still referenced and RESERVED.
      expect(
        (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: stale.generationId } }))
          .quotaReservationIds,
      ).toEqual(staleIds);
      expect((await reservationsOf(stale.generationId)).map((r) => r.outcome)).toEqual(
        staleIds.map(() => "RESERVED"),
      );
    } finally {
      inside.release();
    }
    expect(await pending).toBe("COMPLETE");
    // The next pass, with the account free, clears and releases the stale row.
    expect(
      await releaseStaleBuildReservations({ connectionString: db.urls.runtime }),
    ).toBeGreaterThan(0);
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: stale.generationId } }))
        .quotaReservationIds,
    ).toEqual([]);
    expect((await reservationsOf(stale.generationId)).map((r) => r.outcome)).toEqual(
      staleIds.map(() => "RELEASED"),
    );
    parked.release();
    expect(await staleRun).toBeInstanceOf(Error);
  });

  it("provider revoke paused before publication releases every held reservation", async () => {
    const f = await fixture({ "a.md": "one", "b.md": "two" });
    const a = await f.attach();
    const before = await reserved();
    const paused = barrier();
    let heldCount = 0;
    const pending = run(a.jobId, {
      initialTextReservationBytes: 1,
      afterChunks: paused.wait,
    }).catch((e: unknown) => e);
    try {
      await paused.entered;
      const held = await reservationsOf(a.generationId);
      expect(held.length).toBeGreaterThan(1);
      heldCount = held.length;
      expect(held.every((row) => row.outcome === "RESERVED")).toBe(true);
      await revokeProvider(runtime, f.user.id, { providerId: f.p.providerId });
      expect((await reservationsOf(a.generationId)).every((r) => r.outcome === "RELEASED")).toBe(
        true,
      );
      expect(await reserved()).toBe(before);
      expect(await jobState(a.jobId)).toBe("CANCELLED");
    } finally {
      paused.release();
    }
    expect(await pending).toBeInstanceOf(Error);
    // The resumed worker failed its fence without reserving anything new.
    expect(await reservationsOf(a.generationId)).toHaveLength(heldCount);
    expect((await reservationsOf(a.generationId)).every((r) => r.outcome === "RELEASED")).toBe(
      true,
    );
    expect(await reserved()).toBe(before);
  });

  it("pass 1 tops up a small initial reservation every 64 documents and at its end", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`d${String(i).padStart(2, "0")}.md`, `doc ${i}`]),
    );
    const f = await fixture(files);
    const a = await f.attach();
    let afterPass1: Array<{ outcome: string; amount: string }> = [];
    expect(
      await run(a.jobId, {
        initialTextReservationBytes: 1,
        afterPass1: async () => {
          afterPass1 = await reservationsOf(a.generationId);
        },
      }),
    ).toBe("COMPLETE");
    // The 1-byte estimate, then at least the top-up after document 64.
    expect(afterPass1.length).toBeGreaterThanOrEqual(2);
    expect(afterPass1[0]!.amount).toBe("1");
    expect(afterPass1.every((row) => row.outcome === "RESERVED")).toBe(true);
    expect((await reservationsOf(a.generationId)).every((r) => r.outcome === "RELEASED")).toBe(
      true,
    );
  });

  it("disk contention: a build crossing the floor fails INDEX_DISK_FULL and leaves an existing push reservation intact", async () => {
    const f = await fixture();
    const a = await f.attach();
    mkdirSync(indexDir, { recursive: true });
    const meter = statfsDiskMeter(indexDir);
    const pendingNow = BigInt(await reserved());
    const free = await meter.freeBytes();
    // Leave less headroom than the pass-1 estimate: the push still fits, the build cannot.
    const pushBytes = free - KB_LIMITS.freeDiskFloorBytes - pendingNow - 128n * 1024n * 1024n;
    expect(pushBytes).toBeGreaterThan(0n);
    const push = await transaction((q) =>
      reserveQuota(
        { transactionQuery: q },
        {
          opId: `push:${randomUUID()}`,
          charges: [],
          disks: [{ path: indexDir, bytes: pushBytes, meter }],
          expiresAt: new Date(Date.now() + 3600_000),
        },
      ),
    );
    try {
      await expect(run(a.jobId)).rejects.toThrow("Index build failed");
      expect(
        (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } }))
          .errorCode,
      ).toBe("INDEX_DISK_FULL");
      const pushRows = (
        await db.query(
          "runtime",
          `SELECT outcome::text AS outcome, amount::text AS amount FROM quota_reservation WHERE id = ANY($1::text[])`,
          [push.reservationIds],
        )
      ).rows;
      expect(pushRows).toEqual([{ outcome: "RESERVED", amount: pushBytes.toString() }]);
    } finally {
      await transaction((q) => releaseQuota({ transactionQuery: q }, push.reservationIds));
    }
  });

  it("a superseded attempt whose reset cleanup runs after a lost session never removes its successor's files", async () => {
    const f = await fixture();
    const a = await f.attach();
    const reset = barrier();
    const old = run(a.jobId, { afterReset: reset.wait }).catch((e: unknown) => e);
    try {
      await reset.entered;
      // The old worker's session (and its build permits) is lost after its reset committed.
      await db.query(
        "runtime",
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
            AND l.classid=((hashtextextended($1,24)>>32)&4294967295)::oid
            AND l.objid=(hashtextextended($1,24)&4294967295)::oid`,
        [f.kbId],
      );
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { leaseUntil: new Date(0) } });
      await claimDispatchBatch(prisma, { owner: "recovery", now: new Date() });
      await prisma.durableJob.update({ where: { id: a.jobId }, data: { nextRunAt: new Date(0) } });
      // A successor resets, builds and publishes while the old cleanup is still pending.
      const successor = barrier();
      const next = run(a.jobId, { afterChunks: successor.wait });
      await successor.entered;
      expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.a2.tmp`]);
      // The old attempt's cleanup now runs: it may only reclaim attempts before its own.
      reset.release();
      expect(await old).toBeInstanceOf(Error);
      expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.a2.tmp`]);
      successor.release();
      expect(await next).toBe("COMPLETE");
    } finally {
      reset.release();
      await old;
    }
    expect(filesOf(f.kbId, a.generationId)).toEqual([`${a.generationId}.sqlite`]);
    expect(await active(f.kbId)).toBe(a.generationId);
    expect(await counts(a.generationId)).toBe(1);
  });
});

const quantizationCases = JSON.parse(
  readFileSync(
    new URL("../../../api/src/lib/kb/fixtures/index-quantization-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    name: string;
    vectors: number[][];
    unitF32LeHex: string[];
    int8Scale: number;
    int8: number[][];
    bitsHex: string[];
  }>;
};

describe("stored bytes through the production provider adapter (§1.4)", () => {
  // Raw near-unit reply whose eighth component quantizes to 10 if normalized twice.
  const NEAR_UNIT = [...Array.from({ length: 7 }, () => 0.37778007984161377), 0.031233789399266243];
  const SPEC = { int8: [127, 127, 127, 127, 127, 127, 127, 11], bitsHex: "ff" };

  it("normalizes a provider embedding exactly once (index-quantization-cases dims8-near-unit-rounding-once)", async () => {
    replies.set("near-unit", NEAR_UNIT);
    const f = await fixture({ "one.md": "alpha one" }, { name: "near-unit", dimensions: 8 });
    const a = await f.attach();
    // No injected embedder: the build uses the production HTTP adapter and validateEmbeddings.
    expect(await run(a.jobId, { embedder: undefined })).toBe("COMPLETE");
    const path = generationFilePath(indexDir, f.kbId, a.generationId);
    expect(readIndexFile(path).meta).toMatchObject({ int8_scale: 0.37778007984161377 });
    expect(readStoredVector(path, 1)).toEqual(SPEC);
  });

  it.each(["binary_int8_rescore", "int8"] as const)(
    "stores the dims12-pad-bits fixture bytes (%s) from raw, non-f32-representable provider values",
    async (quantization) => {
      const testCase = quantizationCases.cases.find((c) => c.name === "dims12-pad-bits")!;
      const model = `dims12-${quantization}`;
      replies.set(model, (text) => testCase.vectors[Number(text.trim().slice(1))]!);
      // One chunk per document, in path order: chunk id i+1 carries vector i.
      const files = Object.fromEntries(testCase.vectors.map((_, i) => [`v${i}.md`, `c${i}`]));
      const f = await fixture(files, { name: model, dimensions: 12 });
      await prisma.knowledgeBase.update({
        where: { id: f.kbId },
        data: { indexQuantization: quantization === "int8" ? "INT8" : "BINARY_INT8_RESCORE" },
      });
      const a = await f.attach();
      expect(await run(a.jobId, { embedder: undefined })).toBe("COMPLETE");
      const path = generationFilePath(indexDir, f.kbId, a.generationId);
      expect(readIndexFile(path).meta).toMatchObject({ int8_scale: testCase.int8Scale });
      if (quantization === "int8") {
        expect(testCase.vectors.map((_, i) => readStoredVector(path, i + 1).int8)).toEqual(
          testCase.int8,
        );
      } else {
        expect(testCase.vectors.map((_, i) => readStoredVector(path, i + 1))).toEqual(
          testCase.int8.map((int8, i) => ({ int8, bitsHex: testCase.bitsHex[i] })),
        );
      }
    },
  );

  it("stores spec bytes for sampled and unsampled chunks of a >4,096-chunk build, embedding each once", async () => {
    replies.set("many-chunks", NEAR_UNIT);
    // 41 documents of 32,080 one-letter words: 100 overlapping 400-word windows each.
    const body = Array.from({ length: 32_080 }, (_, i) => (i % 2 ? "w" : "v")).join(" ");
    const files = Object.fromEntries(
      Array.from({ length: 41 }, (_, i) => [`d${String(i).padStart(2, "0")}.md`, body]),
    );
    const f = await fixture(files, { name: "many-chunks", dimensions: 8 });
    const a = await f.attach();
    const before = sent.length;
    expect(await run(a.jobId, { embedder: undefined })).toBe("COMPLETE");
    const row = await prisma.indexGeneration.findUniqueOrThrow({ where: { id: a.generationId } });
    expect(row.chunkCount).toBeGreaterThan(4096);
    // Each chunk was embedded exactly once (the calibration sample is reused, not re-sent).
    const embedded = sent.slice(before).reduce((n, request) => n + request.input.length, 0);
    expect(embedded).toBe(row.chunkCount);
    // stride = ceil(n / 4096) = 2: id 1 is sampled, id 2 is not; both follow the spec.
    const path = generationFilePath(indexDir, f.kbId, a.generationId);
    expect(readStoredVector(path, 1)).toEqual(SPEC);
    expect(readStoredVector(path, 2)).toEqual(SPEC);
    expect(readStoredVector(path, row.chunkCount)).toEqual(SPEC);
  }, 120_000);
});
