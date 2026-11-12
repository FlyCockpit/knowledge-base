import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { GEMMA_MODEL, QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import type { DnsLookupFn } from "@knowledge-base/api/lib/kb/egress";
import { usableIndexProfile } from "@knowledge-base/api/lib/kb/generations";
import { claimDispatchBatch, claimJobAttempt } from "@knowledge-base/api/lib/kb/jobs";
import {
  acquireModelVolumeLease,
  cleanupUnusedBuiltinModelFiles,
  disableLocalModel,
  enableLocalModel as enableModel,
  finishModelDownload,
  getLocalModelStatus,
  QWEN_MODEL_ID,
  readModelRuntimeConfig,
  reconcileQwenRuntimeIdentity,
  recordWorkerMemoryBudget,
  releaseModelVolumeLease,
  removeLocalModelFiles,
  renewModelVolumeLease,
  reserveModelDisk,
  SYSTEM_BUILTIN_PROVIDER_ID,
  setLocalModelRuntimeConfig,
  settleModelDownloadAttempt,
} from "@knowledge-base/api/lib/kb/local-model";
import type { HeldLockLease, LockQuery } from "@knowledge-base/api/lib/kb/lock";
import {
  type ArtifactIdentity,
  ModelArtifactError,
  type ModelHopRequest,
  type ModelHopResponse,
  type ModelTransport,
  QWEN_ARTIFACT,
} from "@knowledge-base/api/lib/kb/model-artifact";
import type { DiskMeter } from "@knowledge-base/api/lib/kb/quota";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";
import { openKbPostgresClusterFromEnv } from "./index";

const publicationBarrier = vi.hoisted(() => ({
  wrap: null as ((handle: FileHandle, path: string) => void) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      publicationBarrier.wrap?.(handle, String(args[0]));
      return handle;
    },
  };
});

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
const routerBindings = vi.hoisted(() => ({ runtime: null as unknown, admitted: () => {} }));
vi.mock("@knowledge-base/api/lib/kb/runtime", () => ({
  getKbRuntime: () => {
    routerBindings.admitted();
    return routerBindings.runtime;
  },
}));

type DownloadResult = { state: string; code?: string };
// Dynamic module URL keeps this composite TS project inside its root, like the
// mirror suite. Production source is typechecked by the worker package.
const { runModelDownload } = (await import(
  new URL("../../../../apps/worker/src/handlers/download-model.ts", import.meta.url).href
)) as {
  runModelDownload(
    db: KbRuntimeConfig["prisma"],
    options: {
      durableJobId: string;
      workerId: string;
      connectionString: string;
      modelsDir: string;
      expected: ArtifactIdentity;
      transport: ModelTransport;
      lookup: DnsLookupFn;
      meter: DiskMeter;
      monitorMs?: number;
      signal?: AbortSignal;
      verifyRuntime: (modelPath: string, modelId: string, signal: AbortSignal) => Promise<unknown>;
    },
  ): Promise<DownloadResult>;
};

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const runtime = { prisma, connectionString: db.urls.runtime };
const roots: string[] = [];
// This lane continues to exercise Qwen explicitly; fresh product state defaults to disabled Gemma1K.
async function enableLocalModel(runtime: Parameters<typeof enableModel>[0]) {
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  const config = await readModelRuntimeConfig(runtime);
  if (config.modelId !== QWEN_MODEL_ID)
    await setLocalModelRuntimeConfig(runtime, {
      modelId: QWEN_MODEL_ID,
      contextTokens: 4096,
      kvKeyType: "f16",
      kvValueType: "f16",
    });
  return enableModel(runtime);
}

afterEach(async () => {
  publicationBarrier.wrap = null;
  await db.query("applier", `DELETE FROM provider_revision WHERE "providerId"=$1`, [
    SYSTEM_BUILTIN_PROVIDER_ID,
  ]);
  await db.query("applier", "DELETE FROM embedding_provider WHERE id=$1", [
    SYSTEM_BUILTIN_PROVIDER_ID,
  ]);
  await db.query("applier", "DELETE FROM kb_local_model WHERE id IS NOT NULL");
  await db.query("applier", "DELETE FROM kb_model_volume_lease WHERE id IS NOT NULL");
  await db.query("applier", "DELETE FROM durable_job WHERE kind = 'DOWNLOAD_MODEL'");
  await db.query("applier", "DELETE FROM quota_reservation WHERE id IS NOT NULL");
  await db.query("applier", "DELETE FROM quota_account WHERE id IS NOT NULL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
});

const PUBLIC: Record<string, string> = {
  "huggingface.co": "18.160.1.1",
  "cdn-lfs.huggingface.co": "18.160.2.2",
  "cas-bridge.xethub.hf.co": "18.160.3.3",
};
const OFFICIAL = new URL(QWEN_ARTIFACT.url);
const OFFICIAL_KEY = `${OFFICIAL.hostname}${OFFICIAL.pathname}`;
const bytes = Buffer.from("fixture-model-".repeat(8192));
const expected: ArtifactIdentity = {
  fileName: QWEN_ARTIFACT.fileName,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const meter: DiskMeter = { freeBytes: async () => 1n << 50n };
const lookup: DnsLookupFn = (hostname, _options, callback) => {
  const address = PUBLIC[hostname];
  if (!address) callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
  else callback(null, [{ address, family: 4 } satisfies LookupAddress]);
};

async function* stream(data: Uint8Array, failAt?: number) {
  for (let offset = 0; offset < data.byteLength; offset += 4096) {
    if (failAt !== undefined && offset >= failAt) throw new Error("connection reset");
    yield data.subarray(offset, offset + 4096);
  }
}
type Route = (req: ModelHopRequest) => ModelHopResponse | Promise<ModelHopResponse>;
function transport(routes: Record<string, Route>): ModelTransport & { seen: ModelHopRequest[] } {
  const seen: ModelHopRequest[] = [];
  return {
    seen,
    async request(req) {
      seen.push(req);
      const route = routes[`${req.url.hostname}${req.url.pathname}`];
      if (!route) throw new Error("unexpected host");
      return route(req);
    },
  };
}
const chain = (final: Route): Record<string, Route> => ({
  [OFFICIAL_KEY]: () => ({
    status: 302,
    headers: { location: "https://cdn-lfs.huggingface.co/lfs/x?sig=a" },
    body: stream(new Uint8Array()),
  }),
  "cdn-lfs.huggingface.co/lfs/x": () => ({
    status: 302,
    headers: { location: "https://cas-bridge.xethub.hf.co/xet/y" },
    body: stream(new Uint8Array()),
  }),
  "cas-bridge.xethub.hf.co/xet/y": final,
});
const full: Route = () => ({
  status: 200,
  headers: { "content-length": String(bytes.byteLength) },
  body: stream(bytes),
});

function modelsDir() {
  const dir = mkdtempSync(join(tmpdir(), "kb-models-"));
  roots.push(dir);
  return dir;
}
async function publish(jobId: string) {
  await db.query(
    "applier",
    `UPDATE durable_job SET state='PUBLISHED', "leaseUntil"=NULL, "workerOwner"=NULL WHERE id=$1`,
    [jobId],
  );
}
async function modelRow() {
  return (await db.query("applier", "SELECT * FROM kb_local_model WHERE id=$1", [QWEN_MODEL_ID]))
    .rows[0] as {
    state: string;
    epoch: number;
    jobId: string;
    quotaReservationIds: string[];
    bytesDownloaded: string;
    errorCode: string | null;
  };
}
async function diskReserved(): Promise<bigint> {
  const row = (
    await db.query(
      "applier",
      `SELECT COALESCE(SUM(reserved),0)::text AS r FROM quota_account WHERE dimension='DISK_VOLUME'`,
    )
  ).rows[0] as { r: string };
  return BigInt(row.r);
}
const q: LockQuery = (async (sql: string, params?: unknown[]) =>
  db.query("runtime", sql, params as unknown[])) as unknown as LockQuery;

function run(
  dir: string,
  jobId: string,
  t: ModelTransport,
  extra: {
    workerId?: string;
    monitorMs?: number;
    signal?: AbortSignal;
    verifyRuntime?: (modelPath: string) => Promise<unknown>;
  } = {},
) {
  return runModelDownload(prisma, {
    verifyRuntime: async (path) => {
      const { modelId: _modelId, ...config } = await readModelRuntimeConfig({
        connectionString: db.urls.runtime,
      });
      await (extra.verifyRuntime ?? (async () => {}))(path);
      return { config, peakRssBytes: null };
    },
    durableJobId: jobId,
    workerId: extra.workerId ?? "worker-a",
    connectionString: db.urls.runtime,
    modelsDir: dir,
    expected,
    transport: t,
    lookup,
    meter,
    monitorMs: extra.monitorMs ?? 50,
    signal: extra.signal,
  });
}

describe("model-download lifecycle", () => {
  it("admin enable increments epoch, creates one durable job, downloads through the allowed chain and becomes READY", async () => {
    const dir = modelsDir();
    const status = await enableLocalModel(runtime);
    expect(status).toMatchObject({ state: "DOWNLOADING", epoch: 1, executable: false });
    const again = await enableLocalModel(runtime);
    expect(again.epoch).toBe(1);
    const row = await modelRow();
    const jobs = await db.query("applier", "SELECT id, desired FROM durable_job");
    expect(jobs.rows).toEqual([{ id: row.jobId, desired: { modelId: QWEN_MODEL_ID, epoch: 1 } }]);
    await publish(row.jobId);
    const t = transport(chain(full));
    await expect(run(dir, row.jobId, t)).resolves.toMatchObject({ state: "READY" });
    expect(t.seen.map((req) => req.address)).toEqual(Object.values(PUBLIC));
    expect(readFileSync(join(dir, QWEN_ARTIFACT.fileName)).equals(bytes)).toBe(true);
    expect(readdirSync(dir)).toEqual([QWEN_ARTIFACT.fileName]);
    const ready = await getLocalModelStatus(prisma);
    expect(ready).toMatchObject({
      state: "READY",
      epoch: 1,
      bytesDownloaded: bytes.byteLength,
      progress: 1,
      errorCode: null,
      reservedBytes: 0,
      // READY is written only after the (here stubbed) runtime probe succeeded.
      executable: true,
    });
    expect(await diskReserved()).toBe(0n);
    const job = (await db.query("applier", "SELECT state FROM durable_job")).rows[0];
    expect(job).toEqual({ state: "COMPLETE" });
  });

  it("fails closed on an unknown redirect host with a fixed code", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await publish(row.jobId);
    const t = transport({
      [OFFICIAL_KEY]: () => ({
        status: 302,
        headers: { location: "https://attacker.example/model" },
        body: stream(new Uint8Array()),
      }),
    });
    await expect(run(dir, row.jobId, t)).resolves.toMatchObject({
      state: "FAILED",
      code: "MODEL_HOST_REJECTED",
    });
    expect(t.seen).toHaveLength(1);
    expect(await getLocalModelStatus(prisma)).toMatchObject({
      state: "FAILED",
      errorCode: "MODEL_HOST_REJECTED",
    });
    expect(await diskReserved()).toBe(0n);
  });

  it("wrong hash reports MODEL_CHECKSUM_MISMATCH, removes temp and releases the disk reservation", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await publish(row.jobId);
    const tampered = Buffer.from(bytes);
    tampered[7] = tampered[7]! ^ 1;
    const t = transport(chain(() => ({ status: 200, headers: {}, body: stream(tampered) })));
    await expect(run(dir, row.jobId, t)).resolves.toMatchObject({
      state: "FAILED",
      code: "MODEL_CHECKSUM_MISMATCH",
    });
    expect(readdirSync(dir)).toEqual([]);
    expect(await diskReserved()).toBe(0n);
    const reservations = await db.query(
      "applier",
      `SELECT outcome::text AS outcome FROM quota_reservation`,
    );
    expect(reservations.rows).toEqual([{ outcome: "RELEASED" }]);
  });

  it("interrupted download retries through the durable job and resumes from the partial temp", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await publish(row.jobId);
    const half = 4096 * 6;
    const first = transport(
      chain(() => ({
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
        body: stream(bytes, half),
      })),
    );
    await expect(run(dir, row.jobId, first)).resolves.toMatchObject({ state: "RETRY" });
    expect(await getLocalModelStatus(prisma)).toMatchObject({ state: "DOWNLOADING" });
    const [partial] = readdirSync(dir);
    expect(statSync(join(dir, partial!)).size).toBe(half);
    const retried = (
      await db.query("applier", `SELECT state::text AS state FROM durable_job WHERE id=$1`, [
        row.jobId,
      ])
    ).rows[0];
    expect(retried).toEqual({ state: "RETRY" });
    await publish(row.jobId);
    const second = transport(
      chain((req) => {
        expect(req.headers.range).toBe(`bytes=${half}-`);
        return {
          status: 206,
          headers: {
            "content-range": `bytes ${half}-${bytes.byteLength - 1}/${bytes.byteLength}`,
          },
          body: stream(bytes.subarray(half)),
        };
      }),
    );
    await expect(run(dir, row.jobId, second)).resolves.toMatchObject({ state: "READY" });
    expect(readFileSync(join(dir, QWEN_ARTIFACT.fileName)).equals(bytes)).toBe(true);
    // Reserved once across both attempts, then committed/dropped once.
    expect(await diskReserved()).toBe(0n);
    const reservations = await db.query(
      "applier",
      `SELECT outcome::text AS outcome FROM quota_reservation`,
    );
    expect(reservations.rows).toEqual([{ outcome: "COMMITTED" }]);
  });

  it("exclusive volume ownership: expiry cannot transfer a live permit, and drained release admits a successor", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await publish(row.jobId);
    const now = new Date();
    expect(await acquireModelVolumeLease(runtime, { owner: "old-worker", now })).toBe(true);
    const t = transport(chain(full));
    await expect(run(dir, row.jobId, t, { workerId: "new-worker" })).resolves.toMatchObject({
      state: "RETRY",
      code: "MODEL_VOLUME_BUSY",
    });
    expect(t.seen).toHaveLength(0);
    expect(await acquireModelVolumeLease(runtime, { owner: "third", now })).toBe(false);
    const later = new Date(now.getTime() + 60_000);
    expect(await acquireModelVolumeLease(runtime, { owner: "new-worker", now: later })).toBe(false);
    // Neither a wrong release nor owner reuse may revoke live work.
    await releaseModelVolumeLease(runtime, { owner: "new-worker" });
    expect(await acquireModelVolumeLease(runtime, { owner: "old-worker", now: later })).toBe(false);
    await releaseModelVolumeLease(runtime, { owner: "old-worker" });
    expect(await acquireModelVolumeLease(runtime, { owner: "new-worker", now: later })).toBe(true);
    await releaseModelVolumeLease(runtime, { owner: "new-worker" });
    expect(await acquireModelVolumeLease(runtime, { owner: "third", now })).toBe(true);
    await releaseModelVolumeLease(runtime, { owner: "third" });
  });

  it("pause, disable and re-enable: the old attempt cannot activate, quota and temp are released once", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const old = await modelRow();
    await publish(old.jobId);
    let pausedResolve: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      pausedResolve = resolve;
    });
    const stalled = transport(
      chain((req) => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield bytes.subarray(0, 4096);
          pausedResolve();
          await new Promise((_resolve, reject) =>
            req.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          );
        })(),
      })),
    );
    const oldRun = run(dir, old.jobId, stalled);
    await paused;
    const reservedDuring = await diskReserved();
    expect(reservedDuring).toBe(BigInt(bytes.byteLength));

    const disabled = await disableLocalModel(runtime);
    expect(disabled).toMatchObject({ state: "DISABLED", epoch: 2 });
    expect(await diskReserved()).toBe(0n);
    const reenabled = await enableLocalModel(runtime);
    expect(reenabled).toMatchObject({ state: "DOWNLOADING", epoch: 3 });

    await expect(oldRun).resolves.toMatchObject({ state: "SUPERSEDED" });
    // Old result cannot activate epoch 1.
    expect(await finishModelDownload(runtime, { epoch: 1, outcome: { state: "READY" } })).toBe(
      false,
    );
    expect(await getLocalModelStatus(prisma)).toMatchObject({ state: "DOWNLOADING", epoch: 3 });
    // Temp removed; quota released exactly once (worker cleanup is a replay).
    expect(readdirSync(dir)).toEqual([]);
    expect(await diskReserved()).toBe(0n);
    const outcomes = await db.query(
      "applier",
      `SELECT outcome::text AS outcome FROM quota_reservation`,
    );
    expect(outcomes.rows).toEqual([{ outcome: "RELEASED" }]);
    const oldJob = (
      await db.query("applier", `SELECT state::text AS state FROM durable_job WHERE id=$1`, [
        old.jobId,
      ])
    ).rows[0];
    expect(oldJob).toEqual({ state: "CANCELLED" });

    const next = await modelRow();
    await publish(next.jobId);
    await expect(run(dir, next.jobId, transport(chain(full)))).resolves.toMatchObject({
      state: "READY",
    });
    expect(await getLocalModelStatus(prisma)).toMatchObject({ state: "READY", epoch: 3 });
  });

  it("a late old job delivery after re-enable is superseded without touching the verified file", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const old = await modelRow();
    await disableLocalModel(runtime);
    await enableLocalModel(runtime);
    const next = await modelRow();
    await publish(next.jobId);
    await expect(run(dir, next.jobId, transport(chain(full)))).resolves.toMatchObject({
      state: "READY",
    });
    const inode = statSync(join(dir, QWEN_ARTIFACT.fileName)).ino;
    // Force-deliver the cancelled old job: the claim refuses it.
    await db.query(
      "applier",
      `UPDATE durable_job SET state='PUBLISHED', "cancelledAt"=NULL WHERE id=$1`,
      [old.jobId],
    );
    const t = transport(chain(full));
    await expect(run(dir, old.jobId, t)).resolves.toMatchObject({ state: "SUPERSEDED" });
    expect(t.seen).toHaveLength(0);
    expect(statSync(join(dir, QWEN_ARTIFACT.fileName)).ino).toBe(inode);
    expect(await getLocalModelStatus(prisma)).toMatchObject({ state: "READY", epoch: 3 });
  });

  it("disable of a READY model keeps the verified file; re-enable verifies it without network", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const first = await modelRow();
    await publish(first.jobId);
    await run(dir, first.jobId, transport(chain(full)));
    await disableLocalModel(runtime);
    expect(await getLocalModelStatus(prisma)).toMatchObject({ state: "DISABLED", epoch: 2 });
    expect(existsSync(join(dir, QWEN_ARTIFACT.fileName))).toBe(true);
    await enableLocalModel(runtime);
    const second = await modelRow();
    await publish(second.jobId);
    const t = transport({});
    await expect(run(dir, second.jobId, t)).resolves.toMatchObject({ state: "READY" });
    expect(t.seen).toHaveLength(0);
    expect(await diskReserved()).toBe(0n);
  });

  it("insufficient disk fails with MODEL_DISK_QUOTA before any network request", async () => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await publish(row.jobId);
    const t = transport(chain(full));
    const result = await runModelDownload(prisma, {
      durableJobId: row.jobId,
      workerId: "worker-a",
      connectionString: db.urls.runtime,
      modelsDir: dir,
      expected,
      transport: t,
      lookup,
      meter: { freeBytes: async () => 1n },
      monitorMs: 50,
      verifyRuntime: async () => {
        throw new Error("must not probe without a verified file");
      },
    });
    expect(result).toMatchObject({ state: "FAILED", code: "MODEL_DISK_QUOTA" });
    expect(t.seen).toHaveLength(0);
  });

  describe("runtime capability gate and SYSTEM_BUILTIN eligibility", () => {
    it("READY only after the runtime probe loads the verified file; the system provider becomes usable", async () => {
      const dir = modelsDir();
      await enableLocalModel(runtime);
      const row = await modelRow();
      await publish(row.jobId);
      const probed: string[] = [];
      await expect(
        run(dir, row.jobId, transport(chain(full)), {
          verifyRuntime: async (path) => {
            // Probe sees the published, checksum-verified file.
            probed.push(readFileSync(path).equals(bytes) ? path : "unverified");
            expect(await getLocalModelStatus(prisma)).toMatchObject({
              state: "DOWNLOADING",
              executable: false,
            });
          },
        }),
      ).resolves.toMatchObject({ state: "READY" });
      expect(probed).toEqual([join(dir, QWEN_ARTIFACT.fileName)]);
      expect(await getLocalModelStatus(prisma)).toMatchObject({ state: "READY", executable: true });
      const profile = await usableIndexProfile(q, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build");
      expect(profile).toMatchObject({ kind: "SYSTEM_BUILTIN", ownerId: null, dimensions: 1024 });
      const revisions = await db.query(
        "applier",
        `SELECT version, ciphertext, "jobId" FROM provider_revision WHERE "providerId"=$1`,
        [SYSTEM_BUILTIN_PROVIDER_ID],
      );
      expect(revisions.rows).toEqual([{ version: 1, ciphertext: null, jobId: row.jobId }]);
    });

    it("an unsupported runtime fails with MODEL_RUNTIME_UNSUPPORTED: no READY, no provider, no activation", async () => {
      const dir = modelsDir();
      await enableLocalModel(runtime);
      const row = await modelRow();
      await publish(row.jobId);
      await expect(
        run(dir, row.jobId, transport(chain(full)), {
          verifyRuntime: async () => {
            throw new ModelArtifactError("MODEL_RUNTIME_UNSUPPORTED");
          },
        }),
      ).resolves.toMatchObject({ state: "FAILED", code: "MODEL_RUNTIME_UNSUPPORTED" });
      expect(await getLocalModelStatus(prisma)).toMatchObject({
        state: "FAILED",
        errorCode: "MODEL_RUNTIME_UNSUPPORTED",
        executable: false,
      });
      const providers = await db.query("applier", "SELECT id FROM embedding_provider WHERE id=$1", [
        SYSTEM_BUILTIN_PROVIDER_ID,
      ]);
      expect(providers.rows).toEqual([]);
      expect(await diskReserved()).toBe(0n);
      // Any non-artifact probe failure maps to the same fixed code.
      await enableLocalModel(runtime);
      const again = await modelRow();
      await publish(again.jobId);
      await expect(
        run(dir, again.jobId, transport({}), {
          verifyRuntime: async () => {
            throw new Error("dlopen failed: private detail");
          },
        }),
      ).resolves.toMatchObject({ state: "FAILED", code: "MODEL_RUNTIME_UNSUPPORTED" });
    });

    it("a wrong checksum never reaches the runtime probe", async () => {
      const dir = modelsDir();
      await enableLocalModel(runtime);
      const row = await modelRow();
      await publish(row.jobId);
      const tampered = Buffer.from(bytes);
      tampered[3] = tampered[3]! ^ 1;
      let probed = false;
      await expect(
        run(
          dir,
          row.jobId,
          transport(chain(() => ({ status: 200, headers: {}, body: stream(tampered) }))),
          {
            verifyRuntime: async () => {
              probed = true;
            },
          },
        ),
      ).resolves.toMatchObject({ state: "FAILED", code: "MODEL_CHECKSUM_MISMATCH" });
      expect(probed).toBe(false);
    });

    it("disable makes the system profile unusable at once; re-enable re-probes and reuses revision 1", async () => {
      const dir = modelsDir();
      await enableLocalModel(runtime);
      const first = await modelRow();
      await publish(first.jobId);
      await run(dir, first.jobId, transport(chain(full)));
      await usableIndexProfile(q, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build");
      await disableLocalModel(runtime);
      await expect(
        usableIndexProfile(q, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build"),
      ).rejects.toMatchObject({
        code: "INDEX_UNAVAILABLE",
      });
      await enableLocalModel(runtime);
      // DOWNLOADING (re-verifying) is not usable either.
      await expect(
        usableIndexProfile(q, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build"),
      ).rejects.toMatchObject({
        code: "INDEX_UNAVAILABLE",
      });
      const second = await modelRow();
      await publish(second.jobId);
      let probes = 0;
      await expect(
        run(dir, second.jobId, transport({}), {
          verifyRuntime: async () => {
            probes += 1;
          },
        }),
      ).resolves.toMatchObject({ state: "READY" });
      expect(probes).toBe(1);
      await expect(
        usableIndexProfile(q, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build"),
      ).resolves.toMatchObject({
        kind: "SYSTEM_BUILTIN",
      });
      const count = await db.query(
        "applier",
        `SELECT count(*)::int AS n FROM provider_revision WHERE "providerId"=$1`,
        [SYSTEM_BUILTIN_PROVIDER_ID],
      );
      expect(count.rows).toEqual([{ n: 1 }]);
    });
  });
});

// Registry-specific lifecycle and deletion boundary, with real authority/model locks.
it("fresh default is disabled Gemma1K; enabling requires a known, admitted memory budget", async () => {
  expect(await getLocalModelStatus(prisma)).toMatchObject({
    state: "DISABLED",
    modelId: GEMMA_MODEL.modelId,
    runtime: { contextTokens: 1024 },
  });
  await expect(enableModel(runtime)).rejects.toMatchObject({ code: "MODEL_MEMORY_BUDGET_UNKNOWN" });
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 512 * 1024 ** 2,
    availableBytes: 512 * 1024 ** 2,
    source: "cgroup-v2",
  });
  await expect(
    enableModel(runtime, undefined, { acknowledgeMemoryWarning: true }),
  ).rejects.toMatchObject({ code: "MODEL_CONFIG_MEMORY_BLOCKED" });
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  expect(await enableModel(runtime)).toMatchObject({
    state: "DOWNLOADING",
    modelId: GEMMA_MODEL.modelId,
    runtime: { contextTokens: 1024 },
  });
  const row = await modelRow();
  const jobs = await db.query("applier", "SELECT desired FROM durable_job WHERE id=$1", [
    row.jobId,
  ]);
  expect(jobs.rows[0]?.desired).toEqual({ modelId: GEMMA_MODEL.modelId, epoch: row.epoch });
});

it("cleanup keeps selected and pending artifacts, removes only an unreferenced regular registry file, and refuses symlinks", async () => {
  const dir = modelsDir();
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  const gemma = join(dir, GEMMA_MODEL.fileName),
    qwen = join(dir, QWEN_MODEL.fileName);
  writeFileSync(gemma, "gemma");
  writeFileSync(qwen, "qwen");
  expect(await acquireModelVolumeLease(runtime, { owner: "cleanup", now: new Date() })).toBe(true);
  try {
    await db.query("applier", 'UPDATE kb_local_model SET "pendingModelId"=$1 WHERE id=$2', [
      QWEN_MODEL.modelId,
      QWEN_MODEL_ID,
    ]);
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(qwen)).toBe(true);
    await db.query("applier", 'UPDATE kb_local_model SET "pendingModelId"=NULL WHERE id=$1', [
      QWEN_MODEL_ID,
    ]);
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(qwen)).toBe(false);
    expect(readFileSync(gemma, "utf8")).toBe("gemma");
    const unrelated = join(dir, "unrelated.gguf");
    writeFileSync(unrelated, "keep");
    symlinkSync(unrelated, qwen);
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(lstatSync(qwen).isSymbolicLink()).toBe(true);
    expect(readFileSync(unrelated, "utf8")).toBe("keep");
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "cleanup" });
  }
});

it("Disable keeps the selected weights; Remove deletes them only once disabled, then clears", async () => {
  const dir = modelsDir();
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  const gemma = join(dir, GEMMA_MODEL.fileName),
    qwen = join(dir, QWEN_MODEL.fileName);
  writeFileSync(gemma, "gemma");
  writeFileSync(qwen, "qwen");
  expect(await enableModel(runtime)).toMatchObject({ state: "DOWNLOADING" });
  await expect(removeLocalModelFiles(runtime)).rejects.toMatchObject({
    code: "MODEL_REMOVE_REQUIRES_DISABLED",
  });
  expect(await disableLocalModel(runtime)).toMatchObject({
    state: "DISABLED",
    removalPending: false,
  });
  expect(await acquireModelVolumeLease(runtime, { owner: "remove", now: new Date() })).toBe(true);
  try {
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(readFileSync(gemma, "utf8")).toBe("gemma");
    expect(await removeLocalModelFiles(runtime)).toMatchObject({
      state: "DISABLED",
      removalPending: true,
    });
    // Idempotent while pending; still only the worker's cleanup touches the volume.
    expect(await removeLocalModelFiles(runtime)).toMatchObject({ removalPending: true });
    expect(existsSync(gemma)).toBe(true);
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(gemma)).toBe(false);
    expect(existsSync(qwen)).toBe(false);
    expect(await getLocalModelStatus(runtime.prisma)).toMatchObject({
      state: "DISABLED",
      removalPending: false,
    });
    // A request voided by an enable never deletes the newly selected weights.
    writeFileSync(gemma, "gemma");
    await removeLocalModelFiles(runtime);
    expect(await enableModel(runtime)).toMatchObject({ removalPending: false });
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(readFileSync(gemma, "utf8")).toBe("gemma");
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "remove" });
  }
});

it("cleanup filesystem failure leaves model selection and artifacts intact and permits a later retry", async () => {
  const dir = modelsDir();
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  const before = await modelRow();
  const gemma = join(dir, GEMMA_MODEL.fileName),
    qwen = join(dir, QWEN_MODEL.fileName);
  writeFileSync(gemma, "gemma");
  writeFileSync(qwen, "qwen");
  const invalidDirectory = join(dir, "not-a-directory");
  writeFileSync(invalidDirectory, "keep");
  expect(
    await acquireModelVolumeLease(runtime, { owner: "cleanup-failure", now: new Date() }),
  ).toBe(true);
  try {
    await expect(cleanupUnusedBuiltinModelFiles(runtime, invalidDirectory)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(await modelRow()).toEqual(before);
    expect(readFileSync(gemma, "utf8")).toBe("gemma");
    expect(readFileSync(qwen, "utf8")).toBe("qwen");
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(qwen)).toBe(false);
    expect(readFileSync(gemma, "utf8")).toBe("gemma");
    expect(readFileSync(invalidDirectory, "utf8")).toBe("keep");
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "cleanup-failure" });
  }
});

it("a selection changed during DOWNLOADING cancels its old job and fences its late runtime result", async () => {
  await enableLocalModel(runtime);
  const old = await modelRow();
  await setLocalModelRuntimeConfig(runtime, {
    modelId: GEMMA_MODEL.modelId,
    contextTokens: 1024,
    kvKeyType: "f16",
    kvValueType: "f16",
  });
  const next = await modelRow();
  expect(next.epoch).toBe(old.epoch + 1);
  expect(next.jobId).not.toBe(old.jobId);
  expect(
    await finishModelDownload(runtime, { epoch: old.epoch, outcome: { state: "READY" } }),
  ).toBe(false);
  expect(await getLocalModelStatus(prisma)).toMatchObject({
    modelId: GEMMA_MODEL.modelId,
    state: "DOWNLOADING",
    epoch: next.epoch,
  });
  expect(
    (
      await db.query("applier", "SELECT state::text AS state FROM durable_job WHERE id=$1", [
        old.jobId,
      ])
    ).rows,
  ).toEqual([{ state: "CANCELLED" }]);
});

it("Gemma's durable enable job downloads its selected artifact and probes that model before activating a 768-d built-in revision", async () => {
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  await enableModel(runtime);
  const row = await modelRow();
  await publish(row.jobId);
  const dir = modelsDir();
  const url = new URL(GEMMA_MODEL.url);
  const selected: ArtifactIdentity = {
    ...expected,
    fileName: GEMMA_MODEL.fileName,
    url: GEMMA_MODEL.url,
  };
  const runtimeProbe = vi.fn(async (path: string, modelId: string) => {
    expect(path).toBe(join(dir, GEMMA_MODEL.fileName));
    expect(modelId).toBe(GEMMA_MODEL.modelId);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    return {
      config: { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" },
      peakRssBytes: 1_000_000_000,
    };
  });
  expect(
    await runModelDownload(prisma, {
      durableJobId: row.jobId,
      workerId: "gemma-download",
      connectionString: db.urls.runtime,
      modelsDir: dir,
      expected: selected,
      transport: transport({ [`${url.hostname}${url.pathname}`]: full }),
      lookup,
      meter,
      verifyRuntime: runtimeProbe,
    }),
  ).toMatchObject({ state: "READY" });
  expect(runtimeProbe).toHaveBeenCalledTimes(1);
  expect(await getLocalModelStatus(prisma)).toMatchObject({
    modelId: GEMMA_MODEL.modelId,
    state: "READY",
    executable: true,
  });
  const revision = (
    await db.query(
      "applier",
      'SELECT model, dimensions FROM provider_revision WHERE "providerId"=$1',
      [SYSTEM_BUILTIN_PROVIDER_ID],
    )
  ).rows;
  expect(revision).toEqual([{ model: GEMMA_MODEL.modelId, dimensions: 768 }]);
  expect(readdirSync(dir)).toEqual([GEMMA_MODEL.fileName]);
});

it.each(["enable", "disable", "setRuntimeConfig"] as const)(
  "live admin policy rejects queued %s after revocation and permits a current admin",
  async (operation) => {
    const actor = await prisma.user.create({
      data: {
        name: "Model admin",
        email: `${crypto.randomUUID()}@example.invalid`,
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await recordWorkerMemoryBudget(runtime, {
      budgetBytes: 8 * 1024 ** 3,
      availableBytes: 7 * 1024 ** 3,
      source: "cgroup-v2",
    });
    if (operation === "disable") await enableModel(runtime);
    routerBindings.runtime = runtime;
    const { kbModelRouter } = await import(
      new URL("../../../api/src/routers/kb-model.ts", import.meta.url).href
    );
    const call = kbModelRouter[operation].callable({
      context: () => ({ session: { user: actor } }),
      path: [operation],
    });
    const invoke = () =>
      operation === "setRuntimeConfig"
        ? call({
            modelId: QWEN_MODEL.modelId,
            contextTokens: 2048,
            kvKeyType: "f16",
            kvValueType: "f16",
          })
        : call();
    const snapshot = async () => ({
      model: await prisma.localModel.findUnique({ where: { id: QWEN_MODEL_ID } }),
      jobs: await prisma.durableJob.count(),
      audits: await prisma.auditEvent.count(),
    });
    for (const revocation of ["demotion", "ban", "email", "2fa", "deleted"]) {
      await db.query(
        "applier",
        `UPDATE "user" SET role='admin', banned=false, "emailVerified"=true, "twoFactorEnabled"=true WHERE id=$1`,
        [actor.id],
      );
      let unlock!: () => void;
      let entered!: (lease: HeldLockLease) => void;
      const ready = new Promise<HeldLockLease>((resolve) => {
        entered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const holder = runLockedOperation({
        connectionString: db.urls.runtime,
        opId: crypto.randomUUID(),
        kind: "authority",
        run: async (lease) => {
          entered(lease);
          await release;
        },
      });
      const lease = await ready;
      let admit!: () => void;
      const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      });
      routerBindings.admitted = admit;
      const before = await snapshot();
      const action = invoke();
      const rejection = expect(action).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      try {
        await admitted;
        await lease.transaction((q) =>
          q(
            revocation === "deleted"
              ? `DELETE FROM "user" WHERE id=$1`
              : `UPDATE "user" SET ${revocation === "demotion" ? "role='user'" : revocation === "ban" ? "banned=true" : revocation === "email" ? '"emailVerified"=false' : '"twoFactorEnabled"=false'} WHERE id=$1`,
            [actor.id],
          ),
        );
      } finally {
        unlock();
        await holder;
      }
      await rejection;
      expect(await snapshot()).toEqual(before);
      if (revocation === "deleted") await prisma.user.create({ data: actor });
    }
    await db.query(
      "applier",
      `UPDATE "user" SET role='admin', banned=false, "emailVerified"=true, "twoFactorEnabled"=true WHERE id=$1`,
      [actor.id],
    );
    routerBindings.admitted = () => {};
    await expect(invoke()).resolves.toBeDefined();
    await db.query("applier", `DELETE FROM "user" WHERE id=$1`, [actor.id]);
  },
);

it("partial recovery retains live ordinary and candidate intent, but reclaims abandoned epochs without following symlinks", async () => {
  const dir = modelsDir();
  const status = await enableLocalModel(runtime);
  const live = join(dir, `.${QWEN_MODEL.fileName}.e${status.epoch}.partial`);
  const obsolete = join(dir, `.${QWEN_MODEL.fileName}.e${status.epoch + 1}.partial`);
  const unrelated = join(dir, ".other.gguf.e1.partial");
  const target = join(dir, "target");
  const symlink = join(dir, `.${GEMMA_MODEL.fileName}.e99.partial`);
  for (const file of [live, obsolete, unrelated, target]) writeFileSync(file, "partial");
  symlinkSync(target, symlink);
  expect(
    await acquireModelVolumeLease(runtime, { owner: "partial-cleanup", now: new Date() }),
  ).toBe(true);
  try {
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(obsolete)).toBe(false);
    await disableLocalModel(runtime);
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(live)).toBe(false);
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("partial");
    expect(existsSync(unrelated)).toBe(true);
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "partial-cleanup" });
  }
});

it("terminal candidate transfer failure cleans partials under its volume hold; restart cleanup preserves a live candidate", async () => {
  const dir = modelsDir();
  await recordWorkerMemoryBudget(runtime, {
    budgetBytes: 8 * 1024 ** 3,
    availableBytes: 7 * 1024 ** 3,
    source: "cgroup-v2",
  });
  const ready = await enableModel(runtime);
  const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
  await finishModelDownload(runtime, {
    epoch: ready.epoch,
    outcome: { state: "READY", probedConfig: config },
  });
  await setLocalModelRuntimeConfig(runtime, { modelId: QWEN_MODEL.modelId, ...config });
  const { qwenConfigProbeStore } = await import("@knowledge-base/api/lib/kb/local-model");
  const { prepareBuiltinConfigArtifact } = await import(
    new URL("../../../../apps/worker/src/handlers/download-model.ts", import.meta.url).href
  );
  const { runQwenConfigProbeTick } = await import(
    new URL("../../../../apps/worker/src/lib/qwen-config-probe.ts", import.meta.url).href
  );
  const partial = join(dir, `.${QWEN_MODEL.fileName}.e${ready.epoch}.partial`);
  writeFileSync(partial, bytes.subarray(0, 4096));
  const owner = "candidate-cleanup";
  expect(await acquireModelVolumeLease(runtime, { owner, now: new Date() })).toBe(true);
  await cleanupUnusedBuiltinModelFiles(runtime, dir);
  expect(existsSync(partial)).toBe(true);
  await releaseModelVolumeLease(runtime, { owner });
  const probe = vi.fn();
  const result = await runQwenConfigProbeTick({
    owner,
    budgetBytes: () => 8 * 1024 ** 3,
    ...qwenConfigProbeStore(runtime, owner),
    supervisor: {
      tryHoldLease: () => acquireModelVolumeLease(runtime, { owner, now: new Date() }),
      releaseLeaseHold: () => releaseModelVolumeLease(runtime, { owner }),
      suspend: async () => {},
      resume: () => {},
      probe,
    },
    prepare: (
      candidate: { modelId: string; epoch: number; config: typeof config },
      signal: AbortSignal,
    ) =>
      prepareBuiltinConfigArtifact({
        runtime,
        modelsDir: dir,
        ...candidate,
        signal,
        deps: {
          lookup,
          transport: {
            request: async () => ({ status: 200, headers: {}, body: stream(bytes, 8192) }),
          },
        },
      }),
    cleanup: () => cleanupUnusedBuiltinModelFiles(runtime, dir),
  });
  expect(result).toBe("failed");
  expect(probe).not.toHaveBeenCalled();
  expect(existsSync(partial)).toBe(false);
  const status = await getLocalModelStatus(prisma);
  expect(status).toMatchObject({
    state: "READY",
    modelId: GEMMA_MODEL.modelId,
    pendingConfig: null,
    configError: { code: "MODEL_CONFIG_PROBE_FAILED" },
  });
  expect(
    await acquireModelVolumeLease(runtime, { owner: "restart-cleanup", now: new Date() }),
  ).toBe(true);
  try {
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
    expect(existsSync(partial)).toBe(false);
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "restart-cleanup" });
  }
});

it.each(["FAILED", "READY"] as const)(
  "interruption during %s settlement rolls back the job, model and quota; reclaimed execution settles once",
  async (outcome) => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await publish(row.jobId);
    // PostgreSQL rejects the domain write AFTER the real terminal job update
    // executed. This fault neither mocks nor replaces the transaction boundary.
    await db.query(
      "applier",
      `CREATE OR REPLACE FUNCTION r44_settlement_fault() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'r44 interrupted settlement'; END $$`,
    );
    await db.query(
      "applier",
      `CREATE OR REPLACE TRIGGER r44_settlement_fault
      BEFORE UPDATE ON kb_local_model FOR EACH ROW
      WHEN (NEW.state::text IN ('READY', 'FAILED')) EXECUTE FUNCTION r44_settlement_fault()`,
    );
    try {
      const interrupted = run(dir, row.jobId, transport(chain(full)), {
        verifyRuntime: async () => {
          if (outcome === "FAILED") throw new ModelArtifactError("MODEL_RUNTIME_UNSUPPORTED");
        },
      });
      if (outcome === "FAILED")
        await expect(interrupted).rejects.toThrow("r44 interrupted settlement");
      else await expect(interrupted).resolves.toMatchObject({ state: "RETRY" });
      expect(
        (
          await db.query("applier", "SELECT state::text AS state FROM durable_job WHERE id=$1", [
            row.jobId,
          ])
        ).rows,
      ).toEqual([{ state: outcome === "FAILED" ? "RUNNING" : "RETRY" }]);
      expect(await modelRow()).toMatchObject({ state: "DOWNLOADING", epoch: row.epoch });
      expect(await diskReserved()).toBe(BigInt(expected.sizeBytes));
      expect(
        (await db.query("applier", "SELECT outcome::text AS outcome FROM quota_reservation")).rows,
      ).toEqual([{ outcome: "RESERVED" }]);
    } finally {
      // Leave a no-op fixture trigger until this disposable database is removed.
      await db.query(
        "applier",
        `CREATE OR REPLACE FUNCTION r44_settlement_fault() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      );
    }
    if (outcome === "FAILED") {
      await db.query("applier", 'UPDATE durable_job SET "leaseUntil"=$2 WHERE id=$1', [
        row.jobId,
        new Date(0),
      ]);
      expect(await claimDispatchBatch(prisma, { owner: "recovery", now: new Date() })).toEqual([]);
    }
    await publish(row.jobId);
    const result = await run(dir, row.jobId, transport({}), {
      verifyRuntime: async () => {
        if (outcome === "FAILED") throw new ModelArtifactError("MODEL_RUNTIME_UNSUPPORTED");
      },
    });
    expect(result.state).toBe(outcome);
    expect(await modelRow()).toMatchObject({ state: outcome });
    expect(await diskReserved()).toBe(0n);
    expect(
      (
        await db.query("applier", "SELECT state::text AS state FROM durable_job WHERE id=$1", [
          row.jobId,
        ])
      ).rows,
    ).toEqual([{ state: outcome === "READY" ? "COMPLETE" : "FAILED" }]);
    expect(
      (await db.query("applier", "SELECT outcome::text AS outcome FROM quota_reservation")).rows,
    ).toEqual([{ outcome: outcome === "READY" ? "COMMITTED" : "RELEASED" }]);
    const next = await enableLocalModel(runtime);
    expect(next.state).toBe(outcome === "READY" ? "READY" : "DOWNLOADING");
  },
);

it.each(["MODEL_DOWNLOAD_FAILED", "MODEL_VOLUME_BUSY"] as const)(
  "%s retry exhaustion settles the model and reservation atomically",
  async (code) => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await reserveModelDisk(runtime, { epoch: row.epoch, dir, meter, expected });
    await db.query("applier", 'UPDATE durable_job SET "attemptCount"=5 WHERE id=$1', [row.jobId]);
    await publish(row.jobId);
    if (code === "MODEL_VOLUME_BUSY")
      expect(
        await acquireModelVolumeLease(runtime, { owner: "other-holder", now: new Date() }),
      ).toBe(true);
    try {
      const result = await run(dir, row.jobId, {
        request: async () => {
          throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
        },
      });
      expect(result).toMatchObject({ state: "FAILED", code });
      expect(await modelRow()).toMatchObject({
        state: "FAILED",
        errorCode: code,
        quotaReservationIds: [],
      });
      expect(await diskReserved()).toBe(0n);
      expect(
        (
          await db.query(
            "applier",
            'SELECT state::text AS state, "attemptCount" FROM durable_job WHERE id=$1',
            [row.jobId],
          )
        ).rows,
      ).toEqual([{ state: "FAILED", attemptCount: 6 }]);
    } finally {
      if (code === "MODEL_VOLUME_BUSY")
        await releaseModelVolumeLease(runtime, { owner: "other-holder" });
    }
  },
);

it("a reclaimed attempt cannot settle its successor's model or quota", async () => {
  const dir = modelsDir();
  await enableLocalModel(runtime);
  const row = await modelRow();
  await reserveModelDisk(runtime, { epoch: row.epoch, dir, meter, expected });
  await publish(row.jobId);
  const old = await claimJobAttempt(prisma, { jobId: row.jobId, workerId: "old", now: new Date() });
  expect(old).not.toBeNull();
  await db.query("applier", 'UPDATE durable_job SET "leaseUntil"=$2 WHERE id=$1', [
    row.jobId,
    new Date(0),
  ]);
  await claimDispatchBatch(prisma, { owner: "replacement", now: new Date() });
  await publish(row.jobId);
  const successor = await claimJobAttempt(prisma, {
    jobId: row.jobId,
    workerId: "successor",
    now: new Date(),
  });
  expect(successor?.attemptEpoch).toBe((old?.attemptEpoch ?? 0) + 1);
  await expect(
    settleModelDownloadAttempt(runtime, {
      epoch: row.epoch,
      jobId: row.jobId,
      workerId: "old",
      attemptEpoch: old!.attemptEpoch,
      outcome: { state: "FAILED", code: "MODEL_CHECKSUM_MISMATCH" },
    }),
  ).rejects.toMatchObject({ name: "DurableJobFenceError" });
  expect(await modelRow()).toMatchObject({ state: "DOWNLOADING" });
  expect(await diskReserved()).toBe(BigInt(expected.sizeBytes));
  await settleModelDownloadAttempt(runtime, {
    epoch: row.epoch,
    jobId: row.jobId,
    workerId: "successor",
    attemptEpoch: successor!.attemptEpoch,
    outcome: { state: "FAILED", code: "MODEL_CHECKSUM_MISMATCH" },
  });
  expect(await modelRow()).toMatchObject({ state: "FAILED" });
  expect(await diskReserved()).toBe(0n);
});

it.each(["COMPLETE", "FAILED", "CANCELLED"] as const)(
  "production reconciliation repairs %s plus DOWNLOADING and releases its reservation once",
  async (jobState) => {
    const dir = modelsDir();
    await enableLocalModel(runtime);
    const row = await modelRow();
    await reserveModelDisk(runtime, { epoch: row.epoch, dir, meter, expected });
    await db.query("applier", 'UPDATE durable_job SET state=$2::"DurableJobState" WHERE id=$1', [
      row.jobId,
      jobState,
    ]);
    await reconcileQwenRuntimeIdentity(runtime);
    await reconcileQwenRuntimeIdentity(runtime);
    expect(await modelRow()).toMatchObject({ state: "FAILED", quotaReservationIds: [] });
    expect(await diskReserved()).toBe(0n);
    expect(
      (await db.query("applier", "SELECT outcome::text AS outcome FROM quota_reservation")).rows,
    ).toEqual([{ outcome: "RELEASED" }]);
    expect((await enableLocalModel(runtime)).state).toBe("DOWNLOADING");
  },
);

it("an expired lease cannot admit production recovery while a real publisher's directory sync is paused", async () => {
  const dir = modelsDir();
  await enableLocalModel(runtime);
  const row = await modelRow();
  await publish(row.jobId);
  let resume!: () => void, entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let intercepted = false;
  publicationBarrier.wrap = (handle, path) => {
    if (path !== dir) return;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      if (intercepted || !existsSync(join(dir, expected.fileName))) return;
      intercepted = true;
      entered();
      await release;
    };
  };
  const writer = run(dir, row.jobId, transport(chain(full)), { monitorMs: 60_000 });
  let inode = 0;
  let result: DownloadResult | undefined;
  try {
    await paused;
    inode = statSync(join(dir, expected.fileName)).ino;
    await db.query("applier", 'UPDATE kb_model_volume_lease SET "leaseUntil"=$1 WHERE id=$2', [
      new Date(0),
      "models",
    ]);
    // This is the exact admission path used by runtime.ts cleanup/probe/child.
    const admitted = await acquireModelVolumeLease(runtime, {
      owner: "qwen:cleanup",
      now: new Date(),
    });
    if (admitted) {
      try {
        await cleanupUnusedBuiltinModelFiles(runtime, dir);
      } finally {
        await releaseModelVolumeLease(runtime, { owner: "qwen:cleanup" });
      }
    }
    expect({ admitted, finalSurvived: existsSync(join(dir, expected.fileName)) }).toEqual({
      admitted: false,
      finalSurvived: true,
    });
    expect(statSync(join(dir, expected.fileName)).ino).toBe(inode);
  } finally {
    resume();
    publicationBarrier.wrap = null;
    result = await writer;
  }
  expect(result).toMatchObject({ state: "READY" });
  expect(statSync(join(dir, expected.fileName)).ino).toBe(inode);
  expect(await acquireModelVolumeLease(runtime, { owner: "qwen:cleanup", now: new Date() })).toBe(
    true,
  );
  try {
    await cleanupUnusedBuiltinModelFiles(runtime, dir);
  } finally {
    await releaseModelVolumeLease(runtime, { owner: "qwen:cleanup" });
  }
  expect(statSync(join(dir, expected.fileName)).ino).toBe(inode);
});

it("a killed lease holder leaves no process permit and its expired DB lease can be reclaimed", async () => {
  const source = `import { PrismaClient } from '@knowledge-base/db/client';
    import { createPrismaPgAdapter } from '@knowledge-base/db/prisma-adapter';
    import { acquireModelVolumeLease } from '@knowledge-base/api/lib/kb/local-model';
    const db = new PrismaClient({adapter:createPrismaPgAdapter({connectionString:process.env.R44_FIXTURE_DATABASE_URL})});
    if (!(await acquireModelVolumeLease({ connectionString: process.env.R44_FIXTURE_DATABASE_URL },{owner:'killed-holder',now:new Date()}))) process.exit(2);
    process.stdout.write('HELD\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      BACKUP_ENABLED: "false",
      DATABASE_URL: db.urls.runtime,
      REDIS_URL: "redis://127.0.0.1:1",
      R44_FIXTURE_DATABASE_URL: db.urls.runtime,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const closed = once(child, "close");
  try {
    const data = await Promise.race([
      once(child.stdout, "data"),
      closed.then(() => {
        throw new Error(`holder exited before admission: ${stderr}`);
      }),
    ]);
    expect(String(data[0])).toContain("HELD");
    expect(await acquireModelVolumeLease(runtime, { owner: "successor", now: new Date() })).toBe(
      false,
    );
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  await db.query("applier", 'UPDATE kb_model_volume_lease SET "leaseUntil"=$1 WHERE id=$2', [
    new Date(0),
    "models",
  ]);
  expect(await acquireModelVolumeLease(runtime, { owner: "successor", now: new Date() })).toBe(
    true,
  );
  await releaseModelVolumeLease(runtime, { owner: "killed-holder" });
  expect(await acquireModelVolumeLease(runtime, { owner: "other", now: new Date() })).toBe(false);
  await releaseModelVolumeLease(runtime, { owner: "successor" });
});

it("shutdown keeps the volume permit until aborted stream cleanup drains, then permits retry", async () => {
  const dir = modelsDir();
  await enableLocalModel(runtime);
  const row = await modelRow();
  await publish(row.jobId);
  const shutdown = new AbortController();
  let drain!: () => void, entered!: () => void, aborted!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const abortSeen = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const writer = run(
    dir,
    row.jobId,
    transport(
      chain((req) => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield bytes.subarray(0, 4096);
          entered();
          try {
            await new Promise<never>((_resolve, reject) =>
              req.signal.addEventListener(
                "abort",
                () => {
                  aborted();
                  reject(new ModelArtifactError("MODEL_CANCELLED"));
                },
                { once: true },
              ),
            );
          } finally {
            await drained;
          }
        })(),
      })),
    ),
    { signal: shutdown.signal },
  );
  try {
    await started;
    shutdown.abort();
    await abortSeen;
    await db.query("applier", 'UPDATE kb_model_volume_lease SET "leaseUntil"=$1 WHERE id=$2', [
      new Date(0),
      "models",
    ]);
    expect(
      await acquireModelVolumeLease(runtime, { owner: "shutdown-cleanup", now: new Date() }),
    ).toBe(false);
  } finally {
    drain();
  }
  expect(await writer).toMatchObject({ state: "RETRY" });
  expect(
    await acquireModelVolumeLease(runtime, { owner: "shutdown-cleanup", now: new Date() }),
  ).toBe(true);
  await releaseModelVolumeLease(runtime, { owner: "shutdown-cleanup" });
  await publish(row.jobId);
  expect(await run(dir, row.jobId, transport(chain(full)))).toMatchObject({ state: "READY" });
});

// R45 uses production admission, SQL leases, epoch settlement and the runtime
// wrapper. Only native model computation is replaced by the guarded IPC fixture.
const { createQwenSupervisor } = await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
);
const { probeQwenRuntime } = await import(
  new URL("../../../../apps/worker/src/lib/qwen-probe.ts", import.meta.url).href
);
function processFixture(dir: string, mode: string, children: ChildProcess[]) {
  // Prebuilt by test-kb.mjs outside timed hooks (flk4).
  const guard = requireBuiltArtifact(
    buildArtifactPath("child-guard"),
    "pnpm test:kb --build-only model-download",
  );
  return {
    guardPath: guard,
    childEntry: join(import.meta.dirname, "fake-qwen.child.mjs"),
    modelPath: join(dir, expected.fileName),
    budgetBytes: () => 64 * 1024 ** 3,
    childEnv: { FAKE_QWEN_DIR: dir, FAKE_QWEN_MODE: mode },
    spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    },
  };
}
async function waitForBoundary(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error("R45 boundary not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe("R45 download verification cancellation", () => {
  it.each(
    (["disable", "supersede", "shutdown"] as const).flatMap((action) =>
      ["hold-load", "hold-document", "hold-probe"].map((mode) => ({ action, mode })),
    ),
  )(
    "$action aborts $mode verification before permit release",
    async ({ action, mode }) => {
      const dir = modelsDir();
      const children: ChildProcess[] = [];
      await enableLocalModel(runtime);
      const row = await modelRow();
      await publish(row.jobId);
      const shutdown = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const writer = runModelDownload(prisma, {
        durableJobId: row.jobId,
        workerId: `r45-${action}-${mode}`,
        connectionString: db.urls.runtime,
        modelsDir: dir,
        expected,
        transport: transport(chain(full)),
        lookup,
        meter,
        monitorMs: 20,
        signal: shutdown.signal,
        verifyRuntime: async (modelPath, modelId, signal) => {
          receivedSignal = signal;
          const { modelId: selected, ...config } = await readModelRuntimeConfig({
            connectionString: db.urls.runtime,
          });
          expect(selected).toBe(modelId);
          const result = await probeQwenRuntime({
            ...processFixture(dir, mode, children),
            modelPath,
            modelId,
            config,
            signal,
            timeoutMs: 10_000,
          });
          return { ...result, config };
        },
      });
      let result: DownloadResult;
      try {
        const marker =
          mode === "hold-load" ? "loading" : mode === "hold-document" ? "embedding" : "probing";
        await waitForBoundary(() =>
          children.some((child) => child.pid && existsSync(join(dir, `${marker}.${child.pid}`))),
        );
        // An active verifier retains the permit even if SQL expiry is forged.
        expect(
          await acquireModelVolumeLease(runtime, { owner: "r45-premature", now: new Date() }),
        ).toBe(false);
        if (action === "shutdown") shutdown.abort();
        else {
          await disableLocalModel(runtime);
          if (action === "supersede") await enableLocalModel(runtime);
        }
        result = await writer;
        expect(receivedSignal?.aborted).toBe(true);
        expect(children.length).toBeGreaterThan(0);
        expect(children.every(exited)).toBe(true);
        expect(result.state).toBe(action === "shutdown" ? "RETRY" : "SUPERSEDED");
        expect((await getLocalModelStatus(prisma)).state).not.toBe("READY");
        expect(
          await acquireModelVolumeLease(runtime, { owner: "r45-successor", now: new Date() }),
        ).toBe(true);
        await releaseModelVolumeLease(runtime, { owner: "r45-successor" });
      } finally {
        shutdown.abort();
        await writer;
      }
      // Subsequent attempt succeeds and enables only its current epoch.
      const current = await modelRow();
      if (action === "disable") await enableLocalModel(runtime);
      const next = action === "disable" ? await modelRow() : current;
      await publish(next.jobId);
      expect(await run(dir, next.jobId, transport(chain(full)))).toMatchObject({
        state: "READY",
      });
      await disableLocalModel(runtime);
    },
    30_000,
  );
});

describe("R45 SQL heartbeat ownership", () => {
  it("a held SQL row allows only one renewal, keeps the Prisma pool usable, kills the real child and joins release", async () => {
    const dir = modelsDir();
    const children: ChildProcess[] = [];
    let calls = 0,
      pending = 0,
      maximum = 0,
      releaseStarted = false,
      released = false;
    const owner = "r45-row-stall";
    const supervisor = createQwenSupervisor({
      ...processFixture(dir, "", children),
      termGraceMs: 100,
      leaseRenewMs: 20,
      leaseRenewTimeoutMs: 250,
      lease: {
        acquire: (signal?: AbortSignal) =>
          acquireModelVolumeLease(runtime, { owner, now: new Date(), signal }),
        renew: async (signal?: AbortSignal) => {
          calls++;
          pending++;
          maximum = Math.max(maximum, pending);
          try {
            return await renewModelVolumeLease(runtime, {
              owner,
              now: new Date(),
              signal,
              timeoutMs: 200,
            });
          } finally {
            pending--;
          }
        },
        release: async () => {
          releaseStarted = true;
          expect(children.every(exited)).toBe(true);
          expect(pending).toBe(0);
          await releaseModelVolumeLease(runtime, { owner, timeoutMs: 2000 });
          released = true;
        },
      },
    });
    const blocker = new Client({
      connectionString: db.urls.runtime,
      connectionTimeoutMillis: 1000,
    });
    await blocker.connect();
    try {
      await supervisor.embed({
        purpose: "query",
        texts: ["ready"],
        runtime: {
          modelId: QWEN_MODEL_ID,
          epoch: 1,
          config: { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" },
        },
      });
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM kb_model_volume_lease WHERE id='models' FOR UPDATE");
      const priorCalls = calls;
      await waitForBoundary(() => pending === 1);
      // Assert the owning database boundary actually has a lock waiter.
      let waits = 0;
      for (let i = 0; i < 50 && waits === 0; i++) {
        const row = await db.query(
          "runtime",
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'kb-model-io-%' AND wait_event_type='Lock' AND query LIKE '%kb_model_volume_lease%'",
        );
        waits = Number(row.rows[0]!.n);
        if (!waits) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waits).toBe(1);
      await Promise.all(Array.from({ length: 20 }, () => prisma.$queryRaw`SELECT 1`));
      await waitForBoundary(() => children.every(exited));
      // Child exit can precede SQL cancellation acknowledgement. The supervisor
      // must join renewal before entering release, while the row stays locked.
      await waitForBoundary(() => releaseStarted);
      // OS exit and SQL cancellation drain concurrently. The renewal wrapper's
      // finally marks settlement only after the owning SQL connection tears down.
      await waitForBoundary(() => pending === 0);
      expect(calls - priorCalls).toBeLessThanOrEqual(1);
      expect(maximum).toBe(1);
      expect(pending).toBe(0);
      expect(released).toBe(false);
      expect(
        await acquireModelVolumeLease(runtime, { owner: "r45-overlap", now: new Date() }),
      ).toBe(false);
      let closed = false;
      const close = supervisor.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      await blocker.query("ROLLBACK");
      await close;
      expect(released).toBe(true);
      expect(await acquireModelVolumeLease(runtime, { owner, now: new Date() })).toBe(true);
      expect(await renewModelVolumeLease(runtime, { owner, now: new Date(0) })).toBe(true);
      await releaseModelVolumeLease(runtime, { owner });
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      await supervisor.close();
      await releaseModelVolumeLease(runtime, { owner });
    }
  });

  it.each([false, true])(
    "delayed renewal samples database time after the row lock (expired=%s)",
    async (expire) => {
      const owner = "r45-delayed";
      const blocker = new Client({
        connectionString: db.urls.runtime,
        connectionTimeoutMillis: 1000,
      });
      await blocker.connect();
      expect(
        await acquireModelVolumeLease(runtime, {
          owner,
          now: new Date(),
          ttlMs: expire ? 300 : 2000,
        }),
      ).toBe(true);
      let renewal: Promise<boolean> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM kb_model_volume_lease WHERE id='models' FOR UPDATE");
        renewal = renewModelVolumeLease(runtime, {
          owner,
          now: new Date(0),
          ttlMs: 2000,
          timeoutMs: 2000,
        });
        await new Promise((resolve) => setTimeout(resolve, expire ? 400 : 100));
        await blocker.query("ROLLBACK");
        expect(await renewal).toBe(!expire);
        if (!expire) {
          const remaining = await db.query(
            "runtime",
            `SELECT extract(epoch FROM ("leaseUntil"-clock_timestamp())) AS remaining FROM kb_model_volume_lease WHERE id='models'`,
          );
          expect(Number(remaining.rows[0]!.remaining)).toBeGreaterThan(1.5);
        }
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        await renewal?.catch(() => {});
        await releaseModelVolumeLease(runtime, { owner });
      }
      expect(await acquireModelVolumeLease(runtime, { owner, now: new Date() })).toBe(true);
      await releaseModelVolumeLease(runtime, { owner });
    },
  );
});

it("R45 abort during real SQL acquisition drains the tentative permit without spawning, then admits healthy work", async () => {
  const owner = "r45-acquire-cancel";
  const dir = modelsDir();
  const children: ChildProcess[] = [];
  expect(await acquireModelVolumeLease(runtime, { owner, now: new Date() })).toBe(true);
  await releaseModelVolumeLease(runtime, { owner });
  const blocker = new Client({ connectionString: db.urls.runtime, connectionTimeoutMillis: 1000 });
  await blocker.connect();
  const controller = new AbortController();
  const supervisor = createQwenSupervisor({
    ...processFixture(dir, "", children),
    lease: {
      acquire: (signal?: AbortSignal) =>
        acquireModelVolumeLease(runtime, { owner, now: new Date(), signal }),
      renew: (signal?: AbortSignal) =>
        renewModelVolumeLease(runtime, { owner, now: new Date(), signal }),
      release: () => releaseModelVolumeLease(runtime, { owner }),
    },
  });
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM kb_model_volume_lease WHERE id='models' FOR UPDATE");
    const input = {
      purpose: "query",
      texts: ["cancel"],
      runtime: {
        modelId: QWEN_MODEL_ID,
        epoch: 1,
        config: { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" },
      },
    };
    pending = supervisor
      .embed({ ...input, signal: controller.signal })
      .catch((error: unknown) => error);
    let waits = 0;
    for (let i = 0; i < 100 && !waits; i++) {
      const row = await db.query(
        "runtime",
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'kb-model-io-%' AND wait_event_type='Lock' AND query LIKE '%kb_model_volume_lease%'",
      );
      waits = Number(row.rows[0]!.n);
      if (!waits) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(waits).toBe(1);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(supervisor.snapshot().spawns).toBe(0);
    const drained = await db.query(
      "runtime",
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'kb-model-io-%' AND wait_event_type='Lock' AND query LIKE '%kb_model_volume_lease%'",
    );
    expect(Number(drained.rows[0]!.n)).toBe(0);
    await blocker.query("ROLLBACK");
    await expect(supervisor.embed(input)).resolves.toHaveLength(1);
    expect(children).toHaveLength(1);
  } finally {
    controller.abort();
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end();
    await pending;
    await supervisor.close();
  }
});

it("R45 a verifier that ignores shutdown and returns successfully cannot mark its download READY", async () => {
  const dir = modelsDir();
  await enableLocalModel(runtime);
  const row = await modelRow();
  await publish(row.jobId);
  const shutdown = new AbortController();
  const result = await run(dir, row.jobId, transport(chain(full)), {
    signal: shutdown.signal,
    verifyRuntime: async () => {
      shutdown.abort();
    },
  });
  expect(result.state).toBe("RETRY");
  expect((await getLocalModelStatus(prisma)).state).toBe("DOWNLOADING");
});
