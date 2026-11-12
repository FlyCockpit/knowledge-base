import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
/**
 * Real-PostgreSQL lane for the built-in embedder runtime config change
 * server-side memory gate, new
 * SYSTEM_BUILTIN fingerprint/generation, sequential deployment-wide re-embedding
 * under the DB lease, query compatibility with EMBEDDING_REBUILD_PENDING
 * notices during the run, and a second config change that retargets the queue
 * and fences the in-flight build.
 *
 * The model child is replaced by a deterministic 1024-d fixture embedder (the
 * real child is the qwen-model lane); everything else (authority transactions,
 * durable jobs, index builds with real DDL, generation leases, hybrid SQL) is
 * the production code against a disposable PostgreSQL and per-generation index files.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { GEMMA_MODEL, QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { QUERY_EMBEDDING_DEADLINE_MS } from "@knowledge-base/api/lib/kb/embed-breaker";
import {
  EmbedderCallError,
  EmbeddingInputTooLongError,
} from "@knowledge-base/api/lib/kb/embed-client";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import * as fingerprints from "@knowledge-base/api/lib/kb/fingerprint";
import {
  QWEN_RUNTIME_VERSIONS,
  qwenEmbeddingFingerprint,
  qwenModelIdentity,
} from "@knowledge-base/api/lib/kb/fingerprint";
import { requestIndexBuild, scheduleIndexBuild } from "@knowledge-base/api/lib/kb/generations";
import {
  generationFilePath,
  readIndexFile,
  startTestIndexReader,
} from "@knowledge-base/api/lib/kb/index-file/testing";
import { getIndexProfile } from "@knowledge-base/api/lib/kb/index-status";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import {
  acquireModelVolumeLease,
  claimQwenConfigProbe,
  cleanupUnusedBuiltinModelFiles,
  commitQwenConfigProbe,
  disableLocalModel,
  enableLocalModel,
  ensureSystemBuiltinProvider,
  failQwenConfigProbe,
  finishModelDownload,
  getLocalModelStatus,
  QWEN_MODEL_ID,
  qwenConfigProbeStore,
  readQwenConfigProbe,
  readReadyModelRuntime,
  reconcileQwenRuntimeIdentity,
  recordWorkerMemoryBudget,
  releaseModelVolumeLease,
  reservePendingModelDisk,
  SYSTEM_BUILTIN_PROVIDER_ID,
  setModelRuntimeConfigInputSchema,
  setLocalModelRuntimeConfig as setRuntimeConfig,
  settlePendingModelDisk,
} from "@knowledge-base/api/lib/kb/local-model";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import { kbReadToolSchemas } from "@knowledge-base/api/lib/kb/protocol/reads";
import { listSystemProviders } from "@knowledge-base/api/lib/kb/providers";
import type { QueryEmbeddingOptions } from "@knowledge-base/api/lib/kb/query-embedding";
import { advanceQwenReembed } from "@knowledge-base/api/lib/kb/qwen-reembed";
import {
  DEFAULT_QWEN_RUNTIME_CONFIG,
  type QwenRuntimeConfig,
  qwenMemoryEstimate,
  qwenRuntimeConfigSchema,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { purgeRetiredGenerations } from "@knowledge-base/api/lib/kb/retention";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { type SearchOptions, searchKnowledgeBase } from "@knowledge-base/api/lib/kb/search";
import { structuredSearchKnowledgeBase } from "@knowledge-base/api/lib/kb/structured-search";
import type { PrismaClient } from "@knowledge-base/db/client";
import { Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deliverIndexBuild } from "./index-delivery";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

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
// The worker's probe orchestration, driven here with a fake model child.
type ProbeDeps = ReturnType<typeof qwenConfigProbeStore> & {
  owner: string;
  budgetBytes(): number | null;
  supervisor: {
    tryHoldLease(): Promise<boolean>;
    releaseLeaseHold(): Promise<void>;
    suspend(): Promise<void>;
    resume(): void;
    probe(
      runtime: { modelId: string; epoch: number; config: QwenRuntimeConfig },
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<{ peakRssBytes: number | null }>;
  };
};
const { runQwenConfigProbeTick } = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-config-probe.ts", import.meta.url).href
)) as {
  runQwenConfigProbeTick(
    deps: ProbeDeps,
  ): Promise<"idle" | "busy" | "interrupted" | "committed" | "failed" | "lost">;
};
const { QwenProbeError } = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
)) as { QwenProbeError: new (code: "MODEL_CONFIG_PROBE_FAILED") => Error };
// The MCP transport's own envelope builder (text warning line).
const { toolSuccess } = (await import(
  new URL("../../../../apps/server/src/mcp/tool-dispatch.ts", import.meta.url).href
)) as {
  toolSuccess(
    name: "knowledge_search" | "knowledge_structured_search",
    data: unknown,
  ): { content: Array<{ type: "text"; text: string }> };
};

function setLocalModelRuntimeConfig(
  runtime: Parameters<typeof setRuntimeConfig>[0],
  input: QwenRuntimeConfig & { modelId?: string; acknowledgeMemoryWarning?: boolean },
) {
  return setRuntimeConfig(runtime, setModelRuntimeConfigInputSchema.parse(input));
}

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
const redis = openKbRedisFromEnv();
const queue = new Queue("kb-qwen-reembed", {
  connection: redis.client(),
  prefix: redis.key("bull"),
});
const reposDir = mkdtempSync(join(tmpdir(), "kb-qwen-reembed-"));
const indexDir = mkdtempSync(join(tmpdir(), "kb-qwen-reembed-index-"));
const indexReader = await startTestIndexReader(indexDir);
const masterKey = Buffer.alloc(32, 27).toString("base64");
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
const modelRuntime = { prisma, connectionString: db.urls.runtime };
const key = () => randomUUID().replaceAll("-", "");
const id = () => `q${key().slice(0, 23)}`;
const tx = <T>(run: (q: LockQuery) => Promise<T>) =>
  runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) => lease.transaction(run),
  });

/**
 * 1024-d fixture model: normalize([1 + #alpha, 1 + #beta, 0, ...]). Deliberately sparse: a
 * one-chunk KB's 0.999-quantile int8 scale is 0, so the build relies on the max fallback.
 */
function fixtureVector(text: string) {
  const words = text.toLowerCase().split(/\s+/);
  const a = 1 + words.filter((w) => w === "alpha").length;
  const b = 1 + words.filter((w) => w === "beta").length;
  const n = Math.hypot(a, b);
  return Array.from({ length: 1024 }, (_, i) => (i === 0 ? a / n : i === 1 ? b / n : 0));
}
const embedder: Embedder = {
  embed: async (texts, o) => {
    await o?.beforeDispatch?.();
    return texts.map(fixtureVector);
  },
};

function commit(kbId: string, files: Record<string, string>) {
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
  execFileSync("git", ["init", "--bare", repo], { env, stdio: "ignore" });
  const blob = (body: string) => git(["hash-object", "-w", "--stdin"], body);
  const assets = git(
    ["mktree"],
    `100644 blob ${blob('{"version":1,"entries":[]}\n')}\tmanifest.json\n`,
  );
  const rows = [
    `040000 tree ${assets}\t.assets`,
    ...Object.entries(files).map(([path, body]) => `100644 blob ${blob(body)}\t${path}`),
  ].sort();
  const root = git(["mktree"], `${rows.join("\n")}\n`);
  const sha = git(["commit-tree", root, "-m", "fixture"]);
  git(["update-ref", "refs/heads/main", sha]);
  return sha;
}

async function publish() {
  await runDurableDispatcherCycle({
    db: prisma,
    ownerId: "qwen-reembed-test",
    now: () => new Date(),
    getQueue: () => queue,
  });
}
function build(
  jobId: string,
  hooks: {
    afterChunks?: () => Promise<void>;
    beforeReserve?: () => Promise<void>;
    afterReserve?: () => Promise<void>;
    afterPass1?: () => Promise<void>;
    embedder?: Embedder | undefined;
  } = {},
  expected: Parameters<typeof deliverIndexBuild>[2] = {},
) {
  return publish().then(() =>
    deliverIndexBuild(
      prisma,
      {
        connectionString: db.urls.runtime,
        indexDir,
        reposDir,
        masterKey,
        workerId: key(),
        durableJobId: jobId,
        afterChunks: hooks.afterChunks,
        beforeReserve: hooks.beforeReserve,
        afterReserve: hooks.afterReserve,
        afterPass1: hooks.afterPass1,
        embedder: hooks.embedder ?? embedder,
      },
      expected,
    ),
  );
}
const jobOf = async (generationId: string) =>
  (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: generationId } })).jobId;

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

/** READY built-in model (verified artifact + runtime) with its system revision 1. */
async function readyModel() {
  const job = await prisma.durableJob.create({
    data: { kind: "DOWNLOAD_MODEL", desired: {}, dedupKey: id(), state: "COMPLETE" },
  });
  await prisma.localModel.create({
    data: {
      id: QWEN_MODEL_ID,
      state: "READY",
      runtimeIdentity: qwenModelIdentity(),
      epoch: 1,
      contextTokens: 4096,
      jobId: job.id,
    },
  });
  return tx((q) =>
    ensureSystemBuiltinProvider(q, job.id, DEFAULT_QWEN_RUNTIME_CONFIG, QWEN_MODEL.modelId),
  );
}

async function kb(
  name: string,
  options: { files?: Record<string, string>; revision?: number; embedder?: Embedder } = {},
) {
  const owner = await user();
  const kbId = id();
  const sha = commit(
    kbId,
    options.files ?? {
      "notes.md": `alpha ${name} alpha notes about the alpha release\n`,
      "other.md": `beta ${name} beta background\n`,
    },
  );
  await prisma.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: owner.id,
      name,
      slug: key(),
      description: "Re-embedding fixture knowledge base",
      state: "ACTIVE",
      headSha: sha,
    },
  });
  const actor = { principal: { kind: "browser" as const, userId: owner.id } };
  // `builtin` without a revision attaches the latest system revision.
  const attached = await requestIndexBuild(runtime, actor, {
    kbId,
    ...(options.revision === undefined
      ? { providerId: "builtin" }
      : { providerId: SYSTEM_BUILTIN_PROVIDER_ID, revision: options.revision }),
    idempotencyKey: key(),
    confirm: "RUN",
  });
  await build(attached.jobId, { embedder: options.embedder });
  return { kbId, actor, name };
}
type Kb = Awaited<ReturnType<typeof kb>>;

/** Starts a search and delivers its query embedding through the worker adapter. */
async function search(f: Kb) {
  let settled = false;
  const pending = searchKnowledgeBase(opts, f.actor, { kbId: f.kbId, query: "alpha release" })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  let request: { id: string } | null = null;
  for (let i = 0; i < 300 && !request && !settled; i++) {
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
      embedder,
    }).catch(() => {});
  }
  const result = await pending;
  if (result instanceof Error) throw result;
  // oRPC `search.hybrid` returns exactly this output schema; MCP wraps it via toolSuccess.
  const parsed = kbReadToolSchemas.knowledge_search.output.parse(result);
  return { result: parsed, mcp: toolSuccess("knowledge_search", parsed) };
}

async function active(kbId: string) {
  const row = await prisma.knowledgeBase.findUniqueOrThrow({
    where: { id: kbId },
    select: { activeGeneration: { select: { id: true, fingerprint: true, state: true } } },
  });
  return row.activeGeneration;
}

/** Re-embedding builds in flight (any SYSTEM_BUILTIN fingerprint): never more than one. */
async function inFlightMigrationBuilds() {
  const rows = await db.query(
    "applier",
    `SELECT g.id FROM index_generation g JOIN durable_job j ON j.id = g."jobId"
      WHERE g."providerId" = $1 AND g.state IN ('PENDING','BUILDING','INDEXING')
        AND j.state NOT IN ('COMPLETE','CANCELLED','FAILED')`,
    [SYSTEM_BUILTIN_PROVIDER_ID],
  );
  return rows.rows.length;
}

/** Index-build reservations of one generation (every attempt) and the DISK_VOLUME ledger. */
async function buildReservations(generationId: string) {
  return (
    await db.query(
      "applier",
      `SELECT outcome::text AS outcome FROM quota_reservation WHERE "opId" LIKE $1`,
      [`index-build:${generationId}:%`],
    )
  ).rows.map((row) => row.outcome as string);
}
async function diskReserved() {
  return (
    await db.query(
      "applier",
      `SELECT COALESCE(sum(reserved),0)::text AS n FROM quota_account WHERE dimension='DISK_VOLUME'`,
    )
  ).rows[0]?.n as string;
}

const advance = () => advanceQwenReembed({ connectionString: db.urls.runtime });
const GiB = 1024 ** 3;

/**
 * One worker probe tick against the real DB state, with a fake child:
 * `outcome` decides whether the candidate config loads and embeds.
 */
async function probeTick(
  outcome: "loads" | "fails" | ((signal?: AbortSignal) => Promise<{ peakRssBytes: number | null }>),
  options: { owner?: string; budgetBytes?: number } = {},
) {
  const owner = options.owner ?? `probe-${key()}`;
  const events: string[] = [];
  const result = await runQwenConfigProbeTick({
    owner,
    budgetBytes: () => options.budgetBytes ?? 64 * GiB,
    ...qwenConfigProbeStore(modelRuntime, owner),
    supervisor: {
      tryHoldLease: async () => true,
      releaseLeaseHold: async () => {},
      suspend: async () => {
        events.push("suspend");
      },
      resume: () => {
        events.push("resume");
      },
      probe: async (_runtime, opts) => {
        if (typeof outcome === "function") return outcome(opts?.signal);
        if (outcome === "fails") throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
        return { peakRssBytes: 2 * GiB };
      },
    },
  });
  return { result, events };
}

/** Admin change + successful load probe: the config takes effect. */
async function applyConfig(config: QwenRuntimeConfig & { acknowledgeMemoryWarning?: boolean }) {
  await setLocalModelRuntimeConfig(modelRuntime, config);
  expect((await probeTick("loads")).result).toBe("committed");
}

afterAll(async () => {
  await indexReader.stop();
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

describe("built-in embedder runtime config change", () => {
  it("gates on the budget server-side, re-embeds one KB at a time with notices, and a second change retargets and fences", {
    timeout: 180_000,
  }, async () => {
    const v1 = await readyModel();
    expect(v1).toBe(1);
    const fp1 = qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG);
    const a = await kb("Atlas");
    const b = await kb("Borealis");
    const c = await kb("Cirrus");
    for (const f of [a, b, c]) expect(await active(f.kbId)).toMatchObject({ fingerprint: fp1 });
    // Stable order: most recently queried first (A, C, B), snapshotted at enqueue.
    for (const [f, at] of [
      [a, "2026-09-26T10:03:00Z"],
      [b, "2026-09-26T10:01:00Z"],
      [c, "2026-09-26T10:02:00Z"],
    ] as const)
      await db.query("applier", `UPDATE knowledge_base SET "lastQueriedAt"=$2 WHERE id=$1`, [
        f.kbId,
        at,
      ]);

    // --- server-side gate against the worker-reported budget -------------------------
    const cfg8k: QwenRuntimeConfig = { contextTokens: 8192, kvKeyType: "f16", kvValueType: "f16" };
    await expect(setLocalModelRuntimeConfig(modelRuntime, cfg8k)).rejects.toMatchObject({
      code: "MODEL_MEMORY_BUDGET_UNKNOWN",
    });
    const need = qwenMemoryEstimate(cfg8k).bytes;
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: Math.floor(need / 0.95),
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    await expect(
      setLocalModelRuntimeConfig(modelRuntime, { ...cfg8k, acknowledgeMemoryWarning: true }),
    ).rejects.toMatchObject({ code: "MODEL_CONFIG_MEMORY_BLOCKED" });
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: Math.floor(need / 0.8),
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    await expect(setLocalModelRuntimeConfig(modelRuntime, cfg8k)).rejects.toMatchObject({
      code: "MODEL_CONFIG_NEEDS_ACKNOWLEDGEMENT",
    });
    // Nothing changed by any refusal.
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      runtime: { contextTokens: 4096 },
      reembed: { total: 0 },
    });
    expect(await prisma.qwenReembed.count()).toBe(0);

    // --- accepted change: pending until the load probe succeeds ---------------
    await setLocalModelRuntimeConfig(modelRuntime, { ...cfg8k, acknowledgeMemoryWarning: true });
    // Nothing takes effect before the probe: no new revision, no retarget, no re-embed.
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      runtime: { contextTokens: 4096 },
      pendingConfig: { contextTokens: 8192, state: "queued" },
      reembed: { total: 0 },
    });
    expect(await prisma.qwenReembed.count()).toBe(0);
    expect(
      await prisma.providerRevision.count({ where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID } }),
    ).toBe(1);
    for (const f of [a, b, c])
      expect(
        (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).profileVersion,
      ).toBe(1);
    expect(await advance()).toEqual({ state: "idle" });
    expect((await probeTick("loads")).result).toBe("committed");
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      pendingConfig: null,
      configError: null,
    });
    const fp2 = qwenEmbeddingFingerprint(cfg8k);
    expect(fp2).not.toBe(fp1);
    const revisions = await prisma.providerRevision.findMany({
      where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID },
      orderBy: { version: "asc" },
      select: { version: true, fingerprint: true },
    });
    expect(revisions).toEqual([
      { version: 1, fingerprint: fp1 },
      { version: 2, fingerprint: fp2 },
    ]);
    for (const f of [a, b, c])
      expect(
        (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).profileVersion,
      ).toBe(2);
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      runtime: { contextTokens: 8192 },
      reembed: { total: 3, done: 0, failed: 0, currentKbId: null },
    });

    // Before any rebuild: every KB still serves hybrid results from its old generation,
    // WITH the notice (oRPC output + MCP text), and index status says rebuilding.
    for (const f of [a, b, c]) {
      const { result, mcp } = await search(f);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.indexNotices).toEqual([
        { kbId: f.kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_SETTINGS_CHANGED" },
      ]);
      expect(mcp.content).toHaveLength(2);
      expect(mcp.content[1]!.text).toMatch(/previous embedding settings; rebuild pending/);
      const status = await getIndexProfile(runtime, f.actor, f.kbId);
      expect(status.index.rebuildPending).toBe("EMBEDDING_SETTINGS_CHANGED");
      expect(status.index.freshness).toBe("current");
    }

    // --- sequential run: A first; the lease never admits a second build --------------
    const first = await advance();
    expect(first).toMatchObject({ state: "started", kbId: a.kbId });
    if (first.state !== "started") throw new Error("unreachable");
    expect(await inFlightMigrationBuilds()).toBe(1);
    // Ticking again while A is in flight never starts another KB.
    expect(await advance()).toEqual({
      state: "running",
      kbId: a.kbId,
      generationId: first.generationId,
    });
    expect(await inFlightMigrationBuilds()).toBe(1);
    await build(await jobOf(first.generationId));
    expect(await active(a.kbId)).toMatchObject({ id: first.generationId, fingerprint: fp2 });
    // Rebuilt KB: no notice; waiting KBs: still notices.
    expect((await search(a)).result.indexNotices).toEqual([]);
    expect((await search(b)).result.indexNotices).toHaveLength(1);
    expect((await getIndexProfile(runtime, a.actor, a.kbId)).index.rebuildPending).toBeNull();

    const second = await advance();
    expect(second).toMatchObject({ state: "started", kbId: c.kbId });
    if (second.state !== "started") throw new Error("unreachable");
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      reembed: { total: 3, done: 1, currentKbId: c.kbId },
    });
    const cBefore = await active(c.kbId);

    // --- a second config change lands while C's build is in flight -------------------
    const cfgQ8: QwenRuntimeConfig = {
      contextTokens: 8192,
      kvKeyType: "q8_0",
      kvValueType: "q8_0",
    };
    const fp3 = qwenEmbeddingFingerprint(cfgQ8);
    let fenced: unknown = null;
    const ledgerBefore = await diskReserved();
    let held: string[] = [];
    await build(await jobOf(second.generationId), {
      afterChunks: async () => {
        held = await buildReservations(second.generationId);
        expect(held.length).toBeGreaterThan(0);
        expect(held.every((o) => o === "RESERVED")).toBe(true);
        // retargetSystemBuiltinKbs cancels this build: it releases before it cancels.
        await applyConfig(cfgQ8);
        expect(await buildReservations(second.generationId)).toEqual(held.map(() => "RELEASED"));
        expect(await diskReserved()).toBe(ledgerBefore);
      },
    }).catch((error: unknown) => {
      fenced = error;
    });
    // The in-flight build was fenced: its late result never activated, and it reserved nothing more.
    expect(fenced).toMatchObject({ name: "DurableJobFenceError" });
    expect(await buildReservations(second.generationId)).toEqual(held.map(() => "RELEASED"));
    expect(await diskReserved()).toBe(ledgerBefore);
    expect(await active(c.kbId)).toEqual(cBefore);
    const cancelled = await prisma.indexGeneration.findUniqueOrThrow({
      where: { id: second.generationId },
      select: { state: true, job: { select: { state: true } } },
    });
    expect(cancelled.state).not.toBe("COMPLETE");
    expect(cancelled.job.state).toBe("CANCELLED");
    // Queued KBs were retargeted to the newest config (revision 3), A included.
    for (const f of [a, b, c])
      expect(
        (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).profileVersion,
      ).toBe(3);
    expect(
      await prisma.qwenReembedLease.findUniqueOrThrow({ where: { id: "qwen" } }),
    ).toMatchObject({ kbId: null, generationId: null });
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      runtime: { kvKeyType: "q8_0" },
      reembed: { total: 3, done: 0, currentKbId: null },
    });

    // --- drain: strictly one at a time until idle -------------------------------------
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      expect(await inFlightMigrationBuilds()).toBe(0);
      const tick = await advance();
      if (tick.state === "idle") break;
      expect(tick.state).toBe("started");
      if (tick.state !== "started") throw new Error("unreachable");
      order.push(tick.kbId);
      expect(await inFlightMigrationBuilds()).toBe(1);
      await build(await jobOf(tick.generationId));
    }
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set([a.kbId, b.kbId, c.kbId]));
    for (const f of [a, b, c]) {
      expect(await active(f.kbId)).toMatchObject({ fingerprint: fp3, state: "COMPLETE" });
      const kbRow = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } });
      expect(kbRow.state).toBe("ACTIVE");
      expect((await search(f)).result.indexNotices).toEqual([]);
    }
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      reembed: { total: 3, done: 3, failed: 0, currentKbId: null },
    });
    expect(await advance()).toEqual({ state: "idle" });

    // --- a model-identity change is never query-compatible: lexical-only + notice ------
    const revision3 = { providerId: SYSTEM_BUILTIN_PROVIDER_ID, version: 3 };
    const identity = (
      await prisma.providerRevision.findUniqueOrThrow({
        where: { providerId_version: revision3 },
      })
    ).modelIdentity;
    await db.query(
      "applier",
      `UPDATE provider_revision SET "modelIdentity"=$3 WHERE "providerId"=$1 AND version=$2`,
      [SYSTEM_BUILTIN_PROVIDER_ID, 3, `sha256:${"e".repeat(64)}`],
    );
    try {
      const embeds = vi.spyOn(embedder, "embed");
      const { result, mcp } = await search(a);
      // No query vector was computed: the lexical arm alone ranked the hits.
      expect(embeds).not.toHaveBeenCalled();
      embeds.mockRestore();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((hit) => hit.mode === "lexical")).toBe(true);
      expect(result.indexNotices).toEqual([
        { kbId: a.kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_MODEL_CHANGED" },
      ]);
      expect(mcp.content[1]!.text).toMatch(/lexical-only/);
      expect((await getIndexProfile(runtime, a.actor, a.kbId)).index.rebuildPending).toBe(
        "EMBEDDING_MODEL_CHANGED",
      );
    } finally {
      await db.query(
        "applier",
        `UPDATE provider_revision SET "modelIdentity"=$3 WHERE "providerId"=$1 AND version=$2`,
        [SYSTEM_BUILTIN_PROVIDER_ID, 3, identity],
      );
    }
    expect((await search(a)).result.results.every((hit) => hit.mode === "hybrid")).toBe(true);
  });

  it("R46r5 F1: ordinary builds and replacement workers wait for cancelled migration execution to drain", {
    timeout: 180_000,
  }, async () => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 64 * GiB,
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    const current = (await readReadyModelRuntime(runtime))!.config;
    const revision = await tx((q) =>
      ensureSystemBuiltinProvider(q, randomUUID(), current, QWEN_MODEL.modelId),
    );
    const a = await kb("Drain A", { revision });
    const b = await kb("Drain B", { revision });
    await prisma.knowledgeBase.update({
      where: { id: a.kbId },
      data: { lastQueriedAt: new Date(Date.now() + 86400_000) },
    });
    const next = {
      ...current,
      contextTokens: current.contextTokens === 1024 ? 2048 : 1024,
    } as QwenRuntimeConfig;
    await applyConfig(next);
    const first = await advance();
    expect(first).toMatchObject({ state: "started", kbId: a.kbId });
    if (first.state !== "started") throw new Error("migration did not start");
    let enter = () => {};
    let resume = () => {};
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const paused = new Promise<void>((r) => {
      resume = r;
    });
    const running = build(await jobOf(first.generationId), {
      afterChunks: async () => {
        enter();
        await paused;
      },
    }).catch((e: unknown) => e);
    try {
      await entered;
      const ordinary = await requestIndexBuild(runtime, b.actor, {
        kbId: b.kbId,
        idempotencyKey: key(),
        confirm: "RUN",
      });
      expect(await build(ordinary.jobId, {}, { skipped: true })).toEqual({ skipped: true });
      expect(
        (await prisma.durableJob.findUniqueOrThrow({ where: { id: ordinary.jobId } })).state,
      ).toBe("PUBLISHED");
      // Supersession frees the durable selection but cannot free the executing session.
      await prisma.knowledgeBase.update({
        where: { id: b.kbId },
        data: { lastQueriedAt: new Date(Date.now() + 2 * 86400_000) },
      });
      const superseding = {
        ...current,
        contextTokens: [1024, 2048, 4096, 8192].find(
          (tier) => tier !== current.contextTokens && tier !== next.contextTokens,
        ),
      } as QwenRuntimeConfig;
      await applyConfig(superseding);
      const successor = await advance();
      expect(successor).toMatchObject({ state: "started", kbId: b.kbId });
      if (successor.state !== "started") throw new Error("successor did not start");
      const replacementJob = await jobOf(successor.generationId);
      expect(await build(replacementJob, {}, { skipped: true })).toEqual({ skipped: true });
      // Another worker delivery.
      expect(await build(replacementJob, {}, { skipped: true })).toEqual({ skipped: true });
      expect(
        (
          await prisma.durableJob.findUniqueOrThrow({
            where: { id: await jobOf(first.generationId) },
          })
        ).state,
      ).toBe("CANCELLED");
      resume();
      expect(await running).toMatchObject({ name: "DurableJobFenceError" });
      expect(await build(replacementJob)).toBe("COMPLETE");
      expect(await active(b.kbId)).toMatchObject({ id: successor.generationId });
    } finally {
      resume();
      await running;
    }
    // Re-entry after drain, including adoption of ordinary durable jobs.
    for (let i = 0; i < 30; i++) {
      const tick = await advance();
      if (tick.state === "idle") break;
      if (tick.state === "started" || tick.state === "running")
        await build(await jobOf(tick.generationId));
    }
    expect(await advance()).toEqual({ state: "idle" });
  });

  // P4 step 9 cancel-lock matrix for the built-in cancellers: retarget (a committed config change,
  // retargetSystemBuiltinKbs) and settleLease (advance() over an off-target leased build). Same
  // cases as the generations suite: (i) queued on AUTH behind a fenced reserve, (i') AUTH budget
  // exceeded then a successful retry, (ii) cancelled before the fenced reserve.
  it.each(
    (["retarget", "settleLease"] as const).flatMap((path) =>
      (["i", "i-prime", "ii"] as const).map((kase) => [path, kase] as const),
    ),
  )("cancel-lock via %s, case (%s)", { timeout: 120_000 }, async (path, kase) => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 64 * GiB,
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    const current = (await readReadyModelRuntime(runtime))!.config;
    const revision = await tx((q) =>
      ensureSystemBuiltinProvider(q, randomUUID(), current, QWEN_MODEL.modelId),
    );
    const a = await kb(`Matrix ${path} ${kase}`, { revision });
    await prisma.knowledgeBase.update({
      where: { id: a.kbId },
      data: { lastQueriedAt: new Date(Date.now() + 30 * 86400_000) },
    });
    const tiers = [1024, 2048, 4096, 8192] as const;
    const next = {
      ...current,
      contextTokens: tiers.find((t) => t !== current.contextTokens)!,
    } as QwenRuntimeConfig;
    await applyConfig(next);
    const first = await advance();
    expect(first).toMatchObject({ state: "started", kbId: a.kbId });
    if (first.state !== "started") throw new Error("migration did not start");
    const jobId = await jobOf(first.generationId);
    const third = tiers.find((t) => t !== current.contextTokens && t !== next.contextTokens)!;
    const cancel = async () => {
      if (path === "retarget") {
        await setLocalModelRuntimeConfig(modelRuntime, { ...next, contextTokens: third });
        expect((await probeTick("loads")).result).toBe("committed");
      } else {
        await db.query("applier", `UPDATE kb_local_model SET "contextTokens"=$2 WHERE id=$1`, [
          QWEN_MODEL_ID,
          third,
        ]);
        try {
          await advance();
        } finally {
          await db.query("applier", `UPDATE kb_local_model SET "contextTokens"=$2 WHERE id=$1`, [
            QWEN_MODEL_ID,
            next.contextTokens,
          ]);
        }
      }
    };
    const jobState = async () =>
      (await prisma.durableJob.findUniqueOrThrow({ where: { id: jobId } })).state;
    const before = await diskReserved();
    if (kase === "ii") {
      let enter = () => {};
      let go = () => {};
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const gate = new Promise<void>((r) => {
        go = r;
      });
      let used = false;
      const running = build(jobId, {
        beforeReserve: async () => {
          if (used) return;
          used = true;
          enter();
          await gate;
        },
      }).catch((e: unknown) => e);
      try {
        await entered;
        await cancel();
        expect(await jobState()).toBe("CANCELLED");
      } finally {
        go();
      }
      expect(await running).toBeInstanceOf(Error);
      expect(await buildReservations(first.generationId)).toEqual([]);
      expect(await diskReserved()).toBe(before);
    } else {
      let enter = () => {};
      let go = () => {};
      let enterPass1 = () => {};
      let goPass1 = () => {};
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const gate = new Promise<void>((r) => {
        go = r;
      });
      const enteredPass1 = new Promise<void>((r) => {
        enterPass1 = r;
      });
      const gatePass1 = new Promise<void>((r) => {
        goPass1 = r;
      });
      let used = false;
      const running = build(jobId, {
        afterReserve: async () => {
          if (used) return;
          used = true;
          enter();
          await gate;
        },
        afterPass1: async () => {
          enterPass1();
          await gatePass1;
        },
      }).catch((e: unknown) => e);
      try {
        await entered;
        if (kase === "i") {
          const cancelling = cancel();
          await new Promise((r) => setTimeout(r, 300));
          expect(await jobState()).toBe("RUNNING");
          go();
          await cancelling;
        } else {
          await expect(cancel()).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
          expect(await jobState()).toBe("RUNNING");
          expect(await buildReservations(first.generationId)).toEqual([]);
          go();
          await enteredPass1;
          expect(await buildReservations(first.generationId)).toContain("RESERVED");
          await cancel();
        }
        expect(await jobState()).toBe("CANCELLED");
      } finally {
        go();
        goPass1();
      }
      expect(await running).toBeInstanceOf(Error);
      const outcomes = await buildReservations(first.generationId);
      expect(outcomes.length).toBeGreaterThan(0);
      expect(outcomes.every((o) => o === "RELEASED")).toBe(true);
      expect(await diskReserved()).toBe(before);
    }
    // Drain the queue for the remaining tests.
    for (let i = 0; i < 30; i++) {
      const tick = await advance();
      if (tick.state === "idle") break;
      if (tick.state === "started" || tick.state === "running")
        await build(await jobOf(tick.generationId));
    }
    expect(await advance()).toEqual({ state: "idle" });
  });

  it("R46r5 F3/F4: queryless pages warn, update recency, and drive stable rebuild priority; rejected reads do not", {
    timeout: 180_000,
  }, async () => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 64 * GiB,
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    const current = (await readReadyModelRuntime(runtime))!.config;
    const revision = await tx((q) =>
      ensureSystemBuiltinProvider(q, randomUUID(), current, QWEN_MODEL.modelId),
    );
    const a = await kb("Priority old", { revision });
    const b = await kb("Priority queryless", {
      revision,
      files: {
        "one.md": "---\ntype: roster\n---\nalpha one\n",
        "two.md": "---\ntype: roster\n---\nalpha two\n",
      },
    });
    // Keep unrelated fixture KBs behind these two; priority is tested through the real producer.
    await db.query("applier", `UPDATE knowledge_base SET "lastQueriedAt"=$1 WHERE id<>$2`, [
      new Date(Date.now() - 86400_000),
      b.kbId,
    ]);
    const options: SearchOptions & { cursorSigner: typeof runtime.cursorSigner } = {
      ...opts,
      cursorSigner: runtime.cursorSigner,
      ratePort: createMemoryRatePort(),
    };
    const page = (input: Record<string, unknown>, overrides: Partial<typeof options> = {}) =>
      structuredSearchKnowledgeBase({ ...options, ...overrides }, b.actor, {
        kbId: b.kbId,
        type: "roster",
        limit: 1,
        ...input,
      });
    const first = await page({});
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const stamp = async () =>
      (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: b.kbId } })).lastQueriedAt;
    expect(await stamp()).not.toBeNull();
    await prisma.knowledgeBase.update({ where: { id: b.kbId }, data: { lastQueriedAt: null } });
    expect((await page({ cursor: first.nextCursor! })).items).toHaveLength(1);
    expect(await stamp()).not.toBeNull();
    const next = {
      ...current,
      contextTokens: current.contextTokens === 1024 ? 2048 : 1024,
    } as QwenRuntimeConfig;
    await applyConfig(next);
    const notice = [
      { kbId: b.kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_SETTINGS_CHANGED" },
    ];
    for (const input of [{}, { type: "absent" }, { cursor: first.nextCursor! }]) {
      const result = await page(input);
      expect(result.indexNotices).toEqual(notice);
      expect(kbReadToolSchemas.knowledge_structured_search.output.parse(result)).toEqual(result);
      const envelope = toolSuccess("knowledge_structured_search", result);
      expect(JSON.parse(envelope.content[0]!.text).data.indexNotices).toEqual(notice);
      expect(envelope.content[1]!.text).toMatch(/previous index.*rebuild pending/);
      expect(envelope.content[1]!.text).not.toMatch(/semantic ranking|lexical-only/);
    }
    // Recency after enqueue never reorders the persisted migration snapshot.
    await structuredSearchKnowledgeBase(options, a.actor, {
      kbId: a.kbId,
      type: "absent",
      limit: 1,
    });
    const selected = await advance();
    expect(selected).toMatchObject({ state: "started", kbId: b.kbId });
    const before = await stamp();
    await expect(
      page({}, { ratePort: { consume: async () => ({ unavailable: true }) } }),
    ).rejects.toBeDefined();
    expect(await stamp()).toEqual(before);
    await expect(page({ cursor: "invalid" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(await stamp()).toEqual(before);
    // A successful SQL read followed by live revocation fails without recording recency.
    await expect(
      structuredSearchKnowledgeBase(
        {
          ...options,
          hooks: {
            afterRead: async () => {
              await prisma.user.update({
                where: { id: b.actor.principal.userId },
                data: { banned: true },
              });
            },
          },
        },
        b.actor,
        { kbId: b.kbId, type: "roster" },
      ),
    ).rejects.toBeDefined();
    expect(await stamp()).toEqual(before);
    await prisma.user.update({ where: { id: b.actor.principal.userId }, data: { banned: false } });
    for (let i = 0; i < 30; i++) {
      const tick = await advance();
      if (tick.state === "idle") break;
      if (tick.state === "started" || tick.state === "running")
        await build(await jobOf(tick.generationId));
    }
    expect(await advance()).toEqual({ state: "idle" });
    expect((await page({})).indexNotices).toEqual([]);
    // Retained cursor pages describe the served old generation, even after the
    // active generation is rebuilt (status alone would miss this notice).
    expect((await page({ cursor: first.nextCursor! })).indexNotices).toEqual(notice);
    // On a config switch-back, this retained cursor's revision is already on
    // target, but the KB's active generation still awaits migration. The status
    // notice must survive even when the served revision itself needs no rebuild.
    await applyConfig(current);
    expect((await page({ cursor: first.nextCursor! })).indexNotices).toEqual(notice);
    for (let i = 0; i < 30; i++) {
      const tick = await advance();
      if (tick.state === "idle") break;
      if (tick.state === "started" || tick.state === "running")
        await build(await jobOf(tick.generationId));
    }
    expect(await advance()).toEqual({ state: "idle" });
  });

  it("an unloadable config is rejected and the old config keeps serving; a crash mid-probe resolves to the last good config; the gap is lexical; dense documents fit the context", {
    timeout: 180_000,
  }, async () => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 64 * GiB,
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    const good = (await readReadyModelRuntime(runtime))!.config;
    const goodFp = qwenEmbeddingFingerprint(good);
    const revision = (
      await prisma.knowledgeBase.findFirst({
        where: { profileProviderId: SYSTEM_BUILTIN_PROVIDER_ID },
        select: { profileVersion: true },
      })
    )?.profileVersion;
    const d = await kb("Dorado", { revision: revision ?? 1 });
    expect(await active(d.kbId)).toMatchObject({ fingerprint: goodFp });
    const revisionsBefore = await prisma.providerRevision.count();
    const reembedBefore = await prisma.qwenReembed.count({ where: { state: "QUEUED" } });

    // --- unloadable candidate: rejected with a clear admin error, nothing switches -----
    const bad: QwenRuntimeConfig = { contextTokens: 8192, kvKeyType: "q4_0", kvValueType: "q4_0" };
    await setLocalModelRuntimeConfig(modelRuntime, { ...bad, acknowledgeMemoryWarning: true });
    for (const budgetBytes of [64 * GiB, 2 * GiB]) {
      if (budgetBytes === 2 * GiB)
        await setLocalModelRuntimeConfig(modelRuntime, { ...bad, acknowledgeMemoryWarning: true });
      const { result, events } = await probeTick("fails", { budgetBytes });
      expect(result).toBe("failed");
      // Tight budget: stop-then-probe, then the old config is resumed.
      expect(events).toEqual(budgetBytes === 2 * GiB ? ["suspend", "resume"] : []);
      expect(await getLocalModelStatus(prisma)).toMatchObject({
        runtime: good,
        pendingConfig: null,
        configError: { code: "MODEL_CONFIG_PROBE_FAILED", ...bad },
      });
      expect((await readReadyModelRuntime(runtime))!.config).toEqual(good);
      expect(await prisma.providerRevision.count()).toBe(revisionsBefore);
      expect(await prisma.qwenReembed.count({ where: { state: "QUEUED" } })).toBe(reembedBefore);
      // Search keeps working on the old config: hybrid, no notice.
      const { result: found } = await search(d);
      expect(found.results.length).toBeGreaterThan(0);
      expect(found.results.every((hit) => hit.mode === "hybrid")).toBe(true);
      expect(found.indexNotices).toEqual([]);
    }
    // Builds keep working on the old config: a rebuild activates on the good fingerprint.
    // (Re-attaching the serving profile would start nothing, R3-L12.)
    const rebuilt = await requestIndexBuild(runtime, d.actor, {
      kbId: d.kbId,
      idempotencyKey: key(),
      confirm: "RUN",
    });
    await build(rebuilt.jobId);
    expect(await active(d.kbId)).toMatchObject({ fingerprint: goodFp, state: "COMPLETE" });

    // --- stop-then-probe gap: search degrades to lexical + notice ---------
    const cfg2k: QwenRuntimeConfig = { contextTokens: 2048, kvKeyType: "f16", kvValueType: "f16" };
    await setLocalModelRuntimeConfig(modelRuntime, cfg2k);
    let gap: Awaited<ReturnType<typeof search>> | null = null;
    const gapTick = await probeTick(
      async () => {
        gap = await search(d);
        throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
      },
      { budgetBytes: 2 * GiB },
    );
    expect(gapTick.result).toBe("failed");
    const during = gap as Awaited<ReturnType<typeof search>> | null;
    expect(during?.result.results.length).toBeGreaterThan(0);
    expect(during?.result.results.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(during?.result.indexNotices).toEqual([
      { kbId: d.kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_RUNTIME_RELOADING" },
    ]);
    expect(during?.mcp.content[1]?.text).toMatch(/lexical-only/);
    // After the failed probe the gap is over: hybrid again, no notice.
    expect((await search(d)).result.indexNotices).toEqual([]);

    // --- crash mid-probe: the claim expires; the next tick resolves to the last good config
    await setLocalModelRuntimeConfig(modelRuntime, cfg2k);
    const dead = qwenConfigProbeStore(modelRuntime, "worker-crashed");
    const pending = await dead.read();
    expect(pending?.pending).toMatchObject({ config: cfg2k, claim: null });
    expect(
      await dead.claim({ probeEpoch: pending!.pending!.probeEpoch, mode: "exclusive", ttlMs: 50 }),
    ).toBe(true);
    // The crashed worker's gap is visible only while its claim is live.
    await new Promise((r) => setTimeout(r, 120));
    expect((await search(d)).result.results.every((hit) => hit.mode === "hybrid")).toBe(true);
    let probed = false;
    const recovered = await probeTick(async () => {
      probed = true;
      return { peakRssBytes: null };
    });
    expect(recovered.result).toBe("interrupted");
    expect(probed).toBe(false);
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      runtime: good,
      pendingConfig: null,
      configError: { code: "MODEL_CONFIG_PROBE_INTERRUPTED", ...cfg2k },
    });
    expect((await readReadyModelRuntime(runtime))!.config).toEqual(good);

    // --- context-fit chunking at contextTokens 1024 ----------------------------
    const cfg1k: QwenRuntimeConfig = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" };
    await applyConfig(cfg1k);
    expect(await getLocalModelStatus(prisma)).toMatchObject({ configError: null });
    const v1k = (
      await prisma.providerRevision.findFirstOrThrow({
        where: {
          providerId: SYSTEM_BUILTIN_PROVIDER_ID,
          fingerprint: qwenEmbeddingFingerprint(cfg1k),
        },
      })
    ).version;
    // Dense tokenizer stand-in: one token per UTF-16 unit + EOS; over-limit input is an error.
    const LIMIT = 1024;
    const count = (text: string) => text.length + 1;
    const fittedBatchSizes: number[] = [];
    const fitted: Embedder = {
      embed: async (texts, o) => {
        fittedBatchSizes.push(texts.length);
        await o?.beforeDispatch?.();
        if (texts.some((text) => count(text) > LIMIT)) throw new EmbeddingInputTooLongError();
        return texts.map(fixtureVector);
      },
      measureInputs: async (texts) => ({ counts: texts.map(count), limit: LIMIT }),
    };
    const words = Array.from(
      { length: 400 },
      (_, i) => `alpha${(i * 7919).toString(36)}Q${i}x${"z".repeat(i % 5)}`,
    );
    const body = `${words.join(" ")}\n`;
    expect(count(words.join(" "))).toBeGreaterThan(LIMIT);
    const dense = await kb("Dense", {
      files: { "dense.md": body },
      revision: v1k,
      embedder: fitted,
    });
    expect(await active(dense.kbId)).toMatchObject({
      fingerprint: qwenEmbeddingFingerprint(cfg1k),
      state: "COMPLETE",
    });
    const generation = (await active(dense.kbId))!.id;
    const rows = readIndexFile(generationFilePath(indexDir, dense.kbId, generation))
      .chunks.filter((chunk) => chunk.path === "dense.md")
      .map((chunk) => ({
        chunk_index: chunk.chunkIndex,
        start_token: chunk.startToken,
        end_token: chunk.endToken,
        start_byte: chunk.startByte,
        end_byte: chunk.endByte,
        body: chunk.text,
      }));
    expect(rows.length).toBeGreaterThan(1);
    expect(fittedBatchSizes).toEqual(rows.map(() => 1));
    const bytes = Buffer.from(body, "utf8");
    for (const [i, row] of rows.entries()) {
      expect(row.chunk_index).toBe(i);
      expect(count(row.body)).toBeLessThanOrEqual(LIMIT);
      // Citation offsets round-trip exactly to the source text.
      expect(
        bytes.subarray(row.start_byte, row.end_byte).toString("utf8").replace(/\s+/g, " "),
      ).toBe(row.body);
      if (i > 0) {
        expect(row.start_byte).toBeLessThan(rows[i - 1]!.end_byte);
        expect(row.start_token).toBeLessThan(rows[i - 1]!.end_token);
      }
    }
  });
  it("a query admitted before the exclusive claim became visible degrades to lexical + notice when the gap fails its embedding", {
    timeout: 120_000,
  }, async () => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 64 * GiB,
      availableBytes: GiB,
      source: "cgroup-v2",
    });
    const current = (await readReadyModelRuntime(runtime))!.config;
    const revision = (
      await prisma.providerRevision.findFirstOrThrow({
        where: {
          providerId: SYSTEM_BUILTIN_PROVIDER_ID,
          fingerprint: qwenEmbeddingFingerprint(current),
        },
      })
    ).version;
    const e = await kb("Eridanus", { revision });
    expect(await active(e.kbId)).toMatchObject({ state: "COMPLETE" });

    const charges = ratePort.counts.get(`kb:query:${e.actor.principal.userId}:${e.kbId}`) ?? 0;
    // Admitted BEFORE any claim: the request row is PENDING, the search waits.
    let settled = false;
    const pending = searchKnowledgeBase(opts, e.actor, { kbId: e.kbId, query: "alpha release" })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    let request: { id: string } | null = null;
    for (let i = 0; i < 300 && !request && !settled; i++) {
      request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: e.kbId, state: "PENDING" },
      });
      if (!request) await new Promise((r) => setTimeout(r, 10));
    }
    expect(request).not.toBeNull();
    expect(settled).toBe(false);

    const candidate: QwenRuntimeConfig = {
      contextTokens: current.contextTokens === 2048 ? 4096 : 2048,
      kvKeyType: "f16",
      kvValueType: "f16",
    };
    await setLocalModelRuntimeConfig(modelRuntime, candidate);
    let outcome: unknown = null;
    const tick = await probeTick(
      async () => {
        // In the stop-then-probe gap the suspended child fails queued queries fast.
        await publish();
        await runQueryEmbeddingDelivery(prisma, {
          ...opts,
          durableJobId: request!.id,
          workerId: key(),
          embedder: {
            embed: async () => {
              // The model child, suspended for a config probe, fails queued queries fast.
              throw new EmbedderCallError();
            },
          },
        }).catch(() => {});
        outcome = await pending;
        throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
      },
      { budgetBytes: 2 * GiB },
    );
    expect(tick.result).toBe("failed");
    expect(tick.events).toEqual(["suspend", "resume"]);
    // The in-flight request's embedding really failed (not a lexical admission): closed as the
    // one degradable closure (closed classification).
    expect(
      (await prisma.queryEmbeddingRequest.findUniqueOrThrow({ where: { id: request!.id } })).state,
    ).toBe("EMBEDDING_UNAVAILABLE");
    expect(outcome).not.toBeInstanceOf(Error);
    const parsed = kbReadToolSchemas.knowledge_search.output.parse(outcome);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(parsed.indexNotices).toEqual([
      { kbId: e.kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_RUNTIME_RELOADING" },
    ]);
    expect(toolSuccess("knowledge_search", parsed).content[1]?.text).toMatch(/lexical-only/);
    expect(ratePort.counts.get(`kb:query:${e.actor.principal.userId}:${e.kbId}`)).toBe(charges + 1);
    expect(await prisma.queryEmbeddingRequest.count({ where: { kbId: e.kbId } })).toBe(1);
    expect(await prisma.generationLease.count({ where: { requestId: request!.id } })).toBe(0);

    // Outside the gap an embedding failure is the model erroring: lexical hits with a
    // LEXICAL_ONLY notice, never a silent degradation; a healthy query is hybrid.
    const outside = searchKnowledgeBase(opts, e.actor, {
      kbId: e.kbId,
      query: "alpha release",
    }).catch((error: unknown) => error);
    let second: { id: string } | null = null;
    for (let i = 0; i < 300 && !second; i++) {
      second = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: e.kbId, state: "PENDING" },
      });
      if (!second) await new Promise((r) => setTimeout(r, 10));
    }
    await publish();
    await runQueryEmbeddingDelivery(prisma, {
      ...opts,
      durableJobId: second!.id,
      workerId: key(),
      embedder: {
        embed: async () => {
          throw new EmbedderCallError();
        },
      },
    }).catch(() => {});
    const degraded = kbReadToolSchemas.knowledge_search.output.parse(await outside);
    expect(degraded.results.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(degraded.indexNotices).toEqual([
      { kbId: e.kbId, code: "LEXICAL_ONLY", detail: "EMBEDDING_PROFILE_UNAVAILABLE" },
    ]);
    expect((await search(e)).result.results.every((hit) => hit.mode === "hybrid")).toBe(true);
  });
  it.each([
    { mode: "hybrid", budgetMs: 60_000, callerDeadline: false },
    { mode: "hybrid", budgetMs: 12_000, callerDeadline: true },
    { mode: "structured", budgetMs: 12_000, callerDeadline: true },
  ] as const)(
    "keeps the whole-search deadline across late embedding failure and blocked lexical SQL ($mode, $budgetMs ms)",
    {
      timeout: 90_000,
    },
    async ({ mode, budgetMs, callerDeadline }) => {
      if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } })))
        await readyModel();
      await recordWorkerMemoryBudget(runtime, {
        budgetBytes: 64 * GiB,
        availableBytes: GiB,
        source: "cgroup-v2",
      });
      const current = (await readReadyModelRuntime(runtime))!.config;
      const revision = (
        await prisma.providerRevision.findFirstOrThrow({
          where: {
            providerId: SYSTEM_BUILTIN_PROVIDER_ID,
            fingerprint: qwenEmbeddingFingerprint(current),
          },
        })
      ).version;
      const f = await kb(`deadline-${mode}-${budgetMs}`, { revision });
      const blocker = new Client({ connectionString: db.urls.applier });
      const observer = new Client(runtime);
      await blocker.connect();
      await observer.connect();
      let pending: Promise<unknown> | undefined;
      let readPid: number | undefined;
      let settledAt: number | undefined;
      const capacityOwners = async () =>
        (
          await observer.query<{ pid: number }>(
            `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
             WHERE a.application_name LIKE 'kb-query-capacity-%' AND locktype='advisory' AND granted AND objsubid=1
             AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
             AND objid=(hashtextextended($1,0)&4294967295)::oid`,
            [`kb:query-slot:${f.actor.principal.userId}:0`],
          )
        ).rows;
      const charges = ratePort.counts.get(`kb:query:${f.actor.principal.userId}:${f.kbId}`) ?? 0;
      try {
        await blocker.query("BEGIN");
        const startedAt = Date.now();
        const deadlineAt = startedAt + budgetMs;
        const bounded = { ...opts, ...(callerDeadline ? { deadlineAt } : {}) };
        const input = { kbId: f.kbId, query: "alpha release" };
        pending = (
          mode === "hybrid"
            ? searchKnowledgeBase(bounded, f.actor, input)
            : structuredSearchKnowledgeBase(
                { ...bounded, cursorSigner: runtime.cursorSigner },
                f.actor,
                input,
              )
        )
          .catch((error: unknown) => error)
          .finally(() => {
            settledAt = Date.now();
          });
        let request: { id: string; deadline: Date } | null = null;
        for (let i = 0; i < 300 && !request && !settledAt; i++) {
          request = await prisma.queryEmbeddingRequest.findFirst({
            where: { kbId: f.kbId, state: "PENDING" },
          });
          if (!request) await new Promise((r) => setTimeout(r, 10));
        }
        expect(request).not.toBeNull();
        // The lease exists; FOR UPDATE of the KB's generations now blocks the index read's
        // FOR KEY SHARE (the read holds it until its reader thread settled).
        await blocker.query(`SELECT id FROM index_generation WHERE "kbId"=$1 FOR UPDATE`, [f.kbId]);
        const embeddingOwners = await capacityOwners();
        expect(embeddingOwners).toHaveLength(1);
        // Spend over half the original budget before the worker fails the admitted embedding,
        // but stay inside the query embedding's own bound (R3-L4): a later failure would be a
        // timeout instead.
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(
              1,
              Math.min(
                startedAt + budgetMs / 2 + 500,
                startedAt + QUERY_EMBEDDING_DEADLINE_MS - 1500,
              ) - Date.now(),
            ),
          ),
        );
        await setLocalModelRuntimeConfig(modelRuntime, {
          contextTokens: current.contextTokens === 2048 ? 4096 : 2048,
          kvKeyType: "f16",
          kvValueType: "f16",
        });
        const tick = await probeTick(
          async () => {
            await publish();
            await runQueryEmbeddingDelivery(prisma, {
              ...opts,
              durableJobId: request!.id,
              workerId: key(),
              embedder: {
                embed: async () => {
                  // The model child, suspended for a config probe, fails queued queries fast.
                  throw new EmbedderCallError();
                },
              },
            }).catch(() => {});
            // Observe the real runtime SQL blocked on our separate connection, not a callback delay.
            for (let i = 0; i < 300 && readPid === undefined && !settledAt; i++) {
              readPid = (
                await observer.query<{ pid: number }>(
                  `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
             AND wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE OF g%'`,
                )
              ).rows[0]?.pid;
              if (readPid === undefined) await new Promise((r) => setTimeout(r, 10));
            }
            // F1 inverse: fallback must retain the original owner, not release
            // and reacquire a slot while the same operation is still in flight.
            expect(await capacityOwners()).toEqual(embeddingOwners);
            // Keep SQL blocked beyond the ORIGINAL deadline, then allow an incorrectly reset timer to finish.
            await new Promise((r) => setTimeout(r, Math.max(1, deadlineAt + 1500 - Date.now())));
            await blocker.query("COMMIT");
            await pending;
            throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
          },
          { budgetBytes: 2 * GiB },
        );
        expect(tick).toEqual({ result: "failed", events: ["suspend", "resume"] });
        expect(readPid).toBeDefined();
        const outcome = await pending;
        console.info(
          `R46r8 deadline ${mode} budget=${budgetMs} elapsed=${settledAt! - startedAt} code=${outcome instanceof Error && "code" in outcome ? outcome.code : "SUCCESS"}`,
        );
        expect(outcome).toMatchObject({ code: "DEADLINE_EXCEEDED" });
        expect(await capacityOwners()).toEqual([]);
        expect(settledAt! - startedAt).toBeLessThan(budgetMs + 1200);
        expect(request!.deadline.getTime()).toBeLessThanOrEqual(deadlineAt + 100);
        expect(
          (await observer.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [readPid]))
            .rowCount,
        ).toBe(0);
        expect(await prisma.generationLease.count({ where: { requestId: request!.id } })).toBe(0);
        expect(await prisma.queryEmbeddingRequest.count({ where: { kbId: f.kbId } })).toBe(1);
        expect(ratePort.counts.get(`kb:query:${f.actor.principal.userId}:${f.kbId}`)).toBe(
          charges + 1,
        );
        expect(
          (await prisma.queryEmbeddingRequest.findUniqueOrThrow({ where: { id: request!.id } }))
            .state,
        ).toBe("EMBEDDING_UNAVAILABLE");
        // Inverse: an exhausted request must not poison later healthy searches on the same index.
        const healthy = (await search(f)).result;
        expect(healthy.results.length).toBeGreaterThan(0);
        expect(healthy.results.every((hit) => hit.mode === "hybrid")).toBe(true);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        await observer.end();
        await pending;
      }
    },
  );
  it("upgrades an already READY/COMPLETE base-runtime installation through fenced durable probes and sequential rebuilds", {
    timeout: 180_000,
  }, async () => {
    // Seed the exact base identity/fingerprint as a new immutable revision. The
    // pre-upgrade column is NULL, as on a real expand-only schema deployment.
    const row = await prisma.localModel.findUniqueOrThrow({ where: { id: QWEN_MODEL_ID } });
    // Use a supported config absent from earlier revisions so this upgrade
    // must create a new current-native revision, not merely reuse one.
    const config = { contextTokens: 8192, kvKeyType: "q4_0", kvValueType: "q4_0" } as const;
    await prisma.localModel.update({ where: { id: QWEN_MODEL_ID }, data: config });
    const oldRuntime = {
      ...QWEN_RUNTIME_VERSIONS,
      runtime: "node-llama-cpp-3.21.1-cpu-fa-on-batch512-v1",
    };
    const oldIdentity = qwenModelIdentity(oldRuntime);
    const oldFingerprint = qwenEmbeddingFingerprint(config, oldRuntime);
    const revision =
      (
        await prisma.providerRevision.aggregate({
          where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID },
          _max: { version: true },
        })
      )._max.version! + 1;
    const current = await prisma.providerRevision.findFirstOrThrow({
      where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID },
      orderBy: { version: "desc" },
    });
    await prisma.providerRevision.create({
      data: {
        ...current,
        version: revision,
        modelIdentity: oldIdentity,
        fingerprint: oldFingerprint,
        idempotencyKey: key(),
        requestHash: oldFingerprint,
      },
    });
    // Only the fingerprint functions are substituted while seeding the exact
    // base deployment. Authority, immutable snapshots and real index SQL are
    // unchanged. Restore them before exercising the production upgrade path.
    await prisma.localModel.update({
      where: { id: QWEN_MODEL_ID },
      data: { runtimeIdentity: oldIdentity },
    });
    const identitySpy = vi.spyOn(fingerprints, "builtinModelIdentity").mockReturnValue(oldIdentity);
    const fingerprintSpy = vi
      .spyOn(fingerprints, "builtinEmbeddingFingerprint")
      .mockReturnValue(oldFingerprint);
    let a: Kb;
    let b: Kb;
    try {
      a = await kb("Runtime upgrade A", { revision });
      b = await kb("Runtime upgrade B", { revision });
    } finally {
      identitySpy.mockRestore();
      fingerprintSpy.mockRestore();
    }
    await prisma.localModel.update({
      where: { id: QWEN_MODEL_ID },
      data: { runtimeIdentity: null },
    });
    await db.query("applier", `UPDATE kb_local_model SET "configError"=NULL WHERE id=$1`, [
      QWEN_MODEL_ID,
    ]);
    expect((await getLocalModelStatus(prisma)).executable).toBe(false);
    expect(await readReadyModelRuntime(runtime)).toBeNull();
    const fallback = await search(a);
    expect(fallback.result.results.length).toBeGreaterThan(0);
    expect(fallback.result.results.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(fallback.result.indexNotices[0]?.detail).toBe("EMBEDDING_MODEL_CHANGED");
    await reconcileQwenRuntimeIdentity(modelRuntime);
    expect(await advance()).toMatchObject({ state: "paused" });
    const queued = await readQwenConfigProbe(prisma);
    expect(queued?.pending).toMatchObject({ config, requiresExclusive: true, claim: null });
    // Restart / same-config retry preserves one durable target and does not
    // create a provider revision or rebuild before successful capability proof.
    await reconcileQwenRuntimeIdentity(modelRuntime);
    await enableLocalModel(modelRuntime);
    await setLocalModelRuntimeConfig(modelRuntime, config);
    const request = (await readQwenConfigProbe(prisma))!.pending!;
    const beforeCount = await prisma.providerRevision.count({
      where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID },
    });
    const failed = await probeTick("fails");
    expect(failed).toMatchObject({ result: "failed", events: ["suspend", "resume"] });
    expect(await probeTick("loads")).toMatchObject({ result: "idle" });
    expect(
      await prisma.providerRevision.count({ where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID } }),
    ).toBe(beforeCount);
    expect((await getLocalModelStatus(prisma)).executable).toBe(false);
    // Explicit unchanged-config save retries the failed identity upgrade.
    await setLocalModelRuntimeConfig(modelRuntime, config);
    const pending = (await readQwenConfigProbe(prisma))!.pending!;
    expect(pending.probeEpoch).toBeGreaterThan(request.probeEpoch);
    expect(
      await claimQwenConfigProbe(prisma, {
        owner: "old-worker",
        probeEpoch: pending.probeEpoch,
        mode: "exclusive",
        ttlMs: 1,
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(
      await commitQwenConfigProbe(modelRuntime, {
        owner: "old-worker",
        probeEpoch: pending.probeEpoch,
        peakRssBytes: GiB,
      }),
    ).toBe(false);
    expect((await probeTick("loads")).result).toBe("interrupted");
    expect((await probeTick("loads")).result).toBe("idle");
    await enableLocalModel(modelRuntime);
    expect((await probeTick("loads")).result).toBe("committed");
    expect((await getLocalModelStatus(prisma)).executable).toBe(true);
    expect(await readReadyModelRuntime(runtime)).toMatchObject({
      epoch: row.epoch + 1,
    });
    expect(
      await commitQwenConfigProbe(modelRuntime, {
        owner: "old-worker",
        probeEpoch: pending.probeEpoch,
        peakRssBytes: GiB,
      }),
    ).toBe(false);
    expect(
      await prisma.providerRevision.count({ where: { providerId: SYSTEM_BUILTIN_PROVIDER_ID } }),
    ).toBe(beforeCount + 1); // New immutable current-native revision required.
    for (const f of [a, b]) {
      expect(await prisma.qwenReembed.findUniqueOrThrow({ where: { kbId: f.kbId } })).toMatchObject(
        { state: "QUEUED" },
      );
      expect((await active(f.kbId))?.fingerprint).toBe(oldFingerprint);
    }
    // Re-enter the production driver after a simulated process restart. The queue includes
    // earlier fixtures (including P4's cancel-lock matrix), not just the two upgrade KBs.
    // One tick per queued build plus one to settle the final lease must drain it.
    const queuedBuilds = await prisma.qwenReembed.count({ where: { state: "QUEUED" } });
    for (let i = 0; i <= queuedBuilds; i++) {
      const result = await advance();
      if (result.state === "idle") break;
      expect(result.state).toBe("started");
      if (result.state === "started")
        expect(await build(await jobOf(result.generationId))).toBe("COMPLETE");
    }
    expect(await advance()).toEqual({ state: "idle" });
    for (const f of [a, b]) {
      expect(await active(f.kbId)).toMatchObject({
        state: "COMPLETE",
        fingerprint: qwenEmbeddingFingerprint(config),
      });
      expect((await search(f)).result.results.some((hit) => hit.mode === "hybrid")).toBe(true);
    }
    const settled = await prisma.localModel.findUniqueOrThrow({ where: { id: QWEN_MODEL_ID } });
    await reconcileQwenRuntimeIdentity(modelRuntime);
    await enableLocalModel(modelRuntime);
    await setLocalModelRuntimeConfig(modelRuntime, config);
    expect(
      (await prisma.localModel.findUniqueOrThrow({ where: { id: QWEN_MODEL_ID } })).configEpoch,
    ).toBe(settled.configEpoch);
    expect((await probeTick("loads")).result).toBe("idle");
  });

  it("disable/enable fences the old probe claim and preserves requested settings for a fresh probe", async () => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 16 * GiB,
      availableBytes: 16 * GiB,
      source: "cgroup-v2",
    });
    const initial = (await readQwenConfigProbe(prisma))!;
    const candidate: QwenRuntimeConfig = {
      ...initial.active,
      contextTokens: initial.active.contextTokens === 1024 ? 2048 : 1024,
    };
    await setLocalModelRuntimeConfig(modelRuntime, candidate);
    const pending = (await readQwenConfigProbe(prisma))!.pending!;
    const owner = id();
    expect(
      await claimQwenConfigProbe(prisma, {
        owner,
        probeEpoch: pending.probeEpoch,
        mode: "exclusive",
        ttlMs: 60_000,
      }),
    ).toBe(true);
    await disableLocalModel(modelRuntime);
    expect(await readQwenConfigProbe(prisma)).toBeNull();
    const enabled = await enableLocalModel(modelRuntime);
    expect(
      await finishModelDownload(modelRuntime, {
        epoch: enabled.epoch,
        outcome: { state: "READY", probedConfig: initial.active, peakRssBytes: GiB },
      }),
    ).toBe(true);
    expect(
      await commitQwenConfigProbe(modelRuntime, {
        owner,
        probeEpoch: pending.probeEpoch,
        peakRssBytes: GiB,
      }),
    ).toBe(false);
    const resumed = (await readQwenConfigProbe(prisma))!;
    expect(resumed.active).toEqual(initial.active);
    expect(resumed.pending).toMatchObject({ config: candidate, claim: null });
    expect(resumed.pending!.probeEpoch).toBeGreaterThan(pending.probeEpoch);
    expect(
      await claimQwenConfigProbe(prisma, {
        owner,
        probeEpoch: resumed.pending!.probeEpoch,
        mode: "exclusive",
        ttlMs: 60_000,
      }),
    ).toBe(true);
    expect(
      await commitQwenConfigProbe(modelRuntime, {
        owner,
        probeEpoch: resumed.pending!.probeEpoch,
        peakRssBytes: GiB,
      }),
    ).toBe(true);
    expect((await readQwenConfigProbe(prisma))!.active).toEqual(candidate);
  });

  it("serve invariant: a new head while the built-in is disabled gets lexical@head over the older built-in hybrid", async () => {
    if (!(await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }))) await readyModel();
    const current = (await readReadyModelRuntime(runtime))!.config;
    const revision = await tx((q) =>
      ensureSystemBuiltinProvider(q, randomUUID(), current, QWEN_MODEL.modelId),
    );
    const f = await kb("Disabled head", { revision });
    const hybrid = (await active(f.kbId))!;
    expect(hybrid.fingerprint).not.toBeNull();
    await disableLocalModel(modelRuntime);
    try {
      const head = commit(f.kbId, { "notes.md": "alpha disabled head notes\n" });
      const scheduled = await tx(async (q) => {
        await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
        return scheduleIndexBuild(q, f.kbId);
      });
      expect(scheduled).not.toBeNull();
      expect(
        await prisma.indexGeneration.findUniqueOrThrow({ where: { id: scheduled!.generationId } }),
      ).toMatchObject({ providerId: null, commitSha: head });
      await build(scheduled!.jobId);
      // lexical@head outranks the hybrid of the older commit; the profile stays attached.
      expect((await active(f.kbId))!.id).toBe(scheduled!.generationId);
      expect(
        (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).profileProviderId,
      ).toBe(SYSTEM_BUILTIN_PROVIDER_ID);
    } finally {
      const enabled = await enableLocalModel(modelRuntime);
      await finishModelDownload(modelRuntime, {
        epoch: enabled.epoch,
        outcome: { state: "READY", probedConfig: current, peakRssBytes: GiB },
      });
    }
  });
});

// 46r10: model identity, dimensions and the sequential slot change together.
it("Qwen to Gemma probes before switching, rebuilds attached KBs sequentially, and serves lexical notices meanwhile", {
  timeout: 180_000,
}, async () => {
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * GiB,
    availableBytes: 7 * GiB,
    source: "cgroup-v2",
  });
  const before = await getLocalModelStatus(prisma);
  const a = await kb("Gemma switch A", {
    revision: (
      await prisma.providerRevision.findFirstOrThrow({
        where: {
          providerId: SYSTEM_BUILTIN_PROVIDER_ID,
          fingerprint: qwenEmbeddingFingerprint((await readReadyModelRuntime(runtime))!.config),
        },
        orderBy: { version: "desc" },
      })
    ).version,
  });
  const b = await kb("Gemma switch B", {
    revision: (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: a.kbId } }))
      .profileVersion!,
  });
  await setLocalModelRuntimeConfig(modelRuntime, {
    modelId: "embeddinggemma-2-q8_0",
    contextTokens: 1024,
    kvKeyType: "f16",
    kvValueType: "f16",
  });
  expect((await getLocalModelStatus(prisma)).modelId).toBe(before.modelId);
  expect((await probeTick("fails")).result).toBe("failed");
  expect((await getLocalModelStatus(prisma)).modelId).toBe(before.modelId);
  await setLocalModelRuntimeConfig(modelRuntime, {
    modelId: "embeddinggemma-2-q8_0",
    contextTokens: 1024,
    kvKeyType: "f16",
    kvValueType: "f16",
  });
  expect((await probeTick("loads")).result).toBe("committed");
  expect(await getLocalModelStatus(prisma)).toMatchObject({
    modelId: "embeddinggemma-2-q8_0",
    runtime: { contextTokens: 1024, batchTokens: 1024 },
  });
  for (const f of [a, b]) {
    const { result, mcp } = await search(f);
    expect(result.results.every((h) => h.mode === "lexical")).toBe(true);
    expect(result.indexNotices[0]?.detail).toBe("EMBEDDING_MODEL_CHANGED");
    expect(mcp.content).toHaveLength(2);
  }
  const gemmaEmbedder: Embedder = {
    embed: async (texts, o) => {
      await o?.beforeDispatch?.();
      return texts.map((t) => fixtureVector(t).slice(0, 768));
    },
  };
  for (let count = 0; count < 50; count++) {
    const next = await advance();
    expect(await inFlightMigrationBuilds()).toBeLessThanOrEqual(1);
    if (next.state === "started")
      await build(await jobOf(next.generationId), { embedder: gemmaEmbedder });
    else if (next.state === "idle") break;
  }
  for (const f of [a, b]) {
    const profile = await getIndexProfile(runtime, f.actor, f.kbId);
    expect(profile.profile).toMatchObject({
      kind: "SYSTEM_BUILTIN",
      model: "embeddinggemma-2-q8_0",
      dimensions: 768,
      contextTokens: 1024,
    });
    expect(profile.index.rebuildPending).toBeNull();
  }
  // Old complete/failed generations retain their Qwen weights until ordinary GC.
  const modelDir = mkdtempSync(join(tmpdir(), "kb-retained-models-"));
  try {
    writeFileSync(join(modelDir, QWEN_MODEL.fileName), "qwen");
    writeFileSync(join(modelDir, GEMMA_MODEL.fileName), "gemma");
    expect(
      await acquireModelVolumeLease(runtime, { owner: "registry-cleanup", now: new Date() }),
    ).toBe(true);
    await cleanupUnusedBuiltinModelFiles(modelRuntime, modelDir);
    expect(existsSync(join(modelDir, QWEN_MODEL.fileName))).toBe(true);
    expect(existsSync(join(modelDir, GEMMA_MODEL.fileName))).toBe(true);
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "registry-cleanup" });
    rmSync(modelDir, { recursive: true, force: true });
  }
});

it("pending artifact disk admission requires the live persisted selection/epoch and settles without stranding quota", async () => {
  const model = QWEN_MODEL;
  const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
  await setLocalModelRuntimeConfig(modelRuntime, { ...config, modelId: model.modelId });
  const state = (await readQwenConfigProbe(prisma))!;
  const owner = "pending-disk-test";
  expect(await acquireModelVolumeLease(runtime, { owner, now: new Date() })).toBe(true);
  expect(
    await claimQwenConfigProbe(prisma, {
      owner,
      probeEpoch: state.pending!.probeEpoch,
      mode: "exclusive",
      ttlMs: 60_000,
    }),
  ).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "kb-pending-disk-"));
  const input = {
    dir,
    meter: { freeBytes: async () => 64n * 1024n ** 3n },
    modelId: model.modelId,
    config,
    epoch: state.modelEpoch,
  };
  try {
    await expect(
      reservePendingModelDisk(modelRuntime, { ...input, epoch: input.epoch - 1 }),
    ).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    await expect(
      reservePendingModelDisk(modelRuntime, { ...input, modelId: GEMMA_MODEL.modelId }),
    ).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    const ids = await reservePendingModelDisk(modelRuntime, input);
    expect(ids.length).toBeGreaterThan(0);
    const reserved = await prisma.quotaReservation.findMany({
      where: { id: { in: ids } },
      select: { amount: true, outcome: true },
      take: ids.length,
    });
    expect(reserved).toEqual([{ amount: BigInt(model.sizeBytes), outcome: "RESERVED" }]);
    await settlePendingModelDisk(modelRuntime, ids);
    await settlePendingModelDisk(modelRuntime, ids);
    expect(
      await prisma.quotaReservation.count({ where: { id: { in: ids }, outcome: "RESERVED" } }),
    ).toBe(0);
    expect(
      await failQwenConfigProbe(modelRuntime, {
        owner,
        probeEpoch: state.pending!.probeEpoch,
        code: "MODEL_CONFIG_PROBE_FAILED",
      }),
    ).toBe(true);
    expect((await getLocalModelStatus(prisma)).modelId).toBe(GEMMA_MODEL.modelId);
  } finally {
    await releaseModelVolumeLease(runtime, { owner });
    rmSync(dir, { recursive: true, force: true });
  }
});

it("current built-in provider projects both models/all offered tiers and returns to an existing revision", async () => {
  const actor = await user();
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 16 * 1024 ** 3,
    availableBytes: 15 * 1024 ** 3,
    source: "cgroup-v2",
  });
  const seen = new Map<string, number>();
  for (const model of [GEMMA_MODEL, QWEN_MODEL, GEMMA_MODEL]) {
    for (const contextTokens of model.contextTiers) {
      const config = qwenRuntimeConfigSchema.parse({
        contextTokens,
        kvKeyType: "f16",
        kvValueType: "f16",
      });
      await disableLocalModel(modelRuntime);
      await setLocalModelRuntimeConfig(modelRuntime, { modelId: model.modelId, ...config });
      const state = await enableLocalModel(modelRuntime);
      expect(
        await finishModelDownload(modelRuntime, {
          epoch: state.epoch,
          outcome: { state: "READY", bytes: model.sizeBytes, probedConfig: config },
        }),
      ).toBe(true);
      const result = await listSystemProviders(runtime, actor.id);
      expect(result.items).toHaveLength(1);
      const row = result.items[0]!;
      expect(row).toMatchObject({
        kind: "SYSTEM_BUILTIN",
        model: model.modelId,
        dimensions: model.dimensions,
        contextTokens,
        status: "ready",
      });
      const choice = `${model.modelId}:${contextTokens}`;
      if (seen.has(choice)) expect(row.revision).toBe(seen.get(choice));
      else seen.set(choice, row.revision);
    }
  }
});

it("real generation purge releases obsolete model weights while retaining its cursor tombstone and replaying cleanup safely", async () => {
  const isolated = await cluster.createDatabase();
  isolated.applyPrismaSchema();

  const client = isolated.createPrismaClient("runtime");
  const modelRuntime = { prisma: client, connectionString: isolated.urls.runtime };
  const dir = mkdtempSync(join(tmpdir(), "kb-purged-model-"));
  try {
    await recordWorkerMemoryBudget(modelRuntime, {
      budgetBytes: 8 * 1024 ** 3,
      availableBytes: 7 * 1024 ** 3,
      source: "cgroup-v2",
    });
    const modelJob = await client.durableJob.create({
      data: { kind: "DOWNLOAD_MODEL", desired: {}, dedupKey: id(), state: "COMPLETE" },
    });
    const revision = await runLockedOperation({
      connectionString: isolated.urls.runtime,
      opId: id(),
      kind: "authority",
      run: (lease) =>
        lease.transaction((q) =>
          ensureSystemBuiltinProvider(
            q,
            modelJob.id,
            DEFAULT_QWEN_RUNTIME_CONFIG,
            QWEN_MODEL.modelId,
          ),
        ),
    });
    const owner = await client.user.create({
      data: { name: "Fixture", email: `${id()}@example.invalid`, emailVerified: true },
    });
    const base = await client.knowledgeBase.create({
      data: {
        name: "Purged model",
        description: "Fixture",
        state: "ACTIVE",
        slug: id(),
        ownerId: owner.id,
        headSha: "1".repeat(40),
      },
    });
    const buildJob = await client.durableJob.create({
      data: { kind: "INDEX_KB", desired: {}, dedupKey: id(), state: "FAILED" },
    });
    const generation = await client.indexGeneration.create({
      data: {
        kbId: base.id,
        jobId: buildJob.id,
        epoch: 1n,
        commitSha: "1".repeat(40),
        providerId: SYSTEM_BUILTIN_PROVIDER_ID,
        providerVersion: revision,
        fingerprint: qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG),
        dimensions: 1024,
        documentCount: 0,
        chunkCount: 0,
      },
    });
    await client.indexGeneration.update({
      where: { id: generation.id },
      data: { state: "FAILED" },
    });
    writeFileSync(join(dir, QWEN_MODEL.fileName), "qwen");
    writeFileSync(join(dir, GEMMA_MODEL.fileName), "gemma");
    expect(
      await acquireModelVolumeLease(
        { connectionString: isolated.urls.runtime },
        { owner: "purged-cleanup", now: new Date() },
      ),
    ).toBe(true);
    await cleanupUnusedBuiltinModelFiles(modelRuntime, dir);
    expect(existsSync(join(dir, QWEN_MODEL.fileName))).toBe(true);
    const purged = await purgeRetiredGenerations({
      connectionString: isolated.urls.runtime,
      indexDir,
      now: new Date(Date.now() + 2 * 86400_000),
    });
    expect(purged).toEqual({ purged: 1 });
    expect(
      await client.indexGeneration.findUniqueOrThrow({ where: { id: generation.id } }),
    ).toMatchObject({ state: "PURGED" });
    await cleanupUnusedBuiltinModelFiles(modelRuntime, dir);
    expect(existsSync(join(dir, QWEN_MODEL.fileName))).toBe(false);
    expect(existsSync(join(dir, GEMMA_MODEL.fileName))).toBe(true);
    await cleanupUnusedBuiltinModelFiles(modelRuntime, dir);
    expect(
      await client.indexGeneration.findUniqueOrThrow({ where: { id: generation.id } }),
    ).toMatchObject({ state: "PURGED" });
    expect(
      await purgeRetiredGenerations({
        connectionString: isolated.urls.runtime,
        indexDir,
        now: new Date(Date.now() + 2 * 86400_000),
      }),
    ).toEqual({ purged: 0 });
  } finally {
    await releaseModelVolumeLease(
      { connectionString: isolated.urls.runtime },
      { owner: "purged-cleanup" },
    );
    await client.$disconnect();
    await isolated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
