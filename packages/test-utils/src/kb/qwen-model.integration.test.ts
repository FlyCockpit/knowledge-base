import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
/**
 * Real-model lane for the built-in Qwen embedder.
 *
 * Runs ONLY under `pnpm test:kb -- qwen-model`, which first verifies the
 * checksum-cached artifact (KB_QWEN_MODEL_PATH) and builds the worker bundle.
 * The parent here is the real supervisor; the child is the real bundled
 * `apps/worker/dist/qwen-child.mjs` forked through the compiled native guard
 * and loading the pinned, patched node-llama-cpp CPU source build. Exit evidence is /proc
 * state and PIDs, never a kill spy or RSS. A missing artifact/bundle/toolchain
 * FAILS (throws in beforeAll) — there is no skip-if-missing path.
 *
 * The Node26-slim x64/arm64 image lanes are scripts/test-qwen-image.mjs, run by
 * the same suite; this file runs on the invoking host's Node.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as realTimeout } from "node:timers";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import { chunkBody, fitChunksToContext } from "@knowledge-base/api/lib/kb/chunk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import type { Embedder as IndexEmbedder } from "@knowledge-base/api/lib/kb/embedder";
import {
  qwenEmbeddingFingerprint,
  qwenModelIdentity,
} from "@knowledge-base/api/lib/kb/fingerprint";
import { requestIndexBuild } from "@knowledge-base/api/lib/kb/generations";
import { generationFilePath, readIndexFile } from "@knowledge-base/api/lib/kb/index-file/testing";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import {
  ensureSystemBuiltinProvider,
  QWEN_MODEL_ID,
  SYSTEM_BUILTIN_PROVIDER_ID,
} from "@knowledge-base/api/lib/kb/local-model";
import { estimateBuiltinPeakBytes } from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";
import { deliverIndexBuild } from "./index-delivery";
import { modelInference } from "./model-inference";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { expectRawEmbedding } from "./raw-embedding";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));

type Purpose = "query" | "document";
type Supervisor = {
  embed(input: {
    purpose: Purpose;
    texts: string[];
    runtime: {
      modelId: string;
      epoch: number;
      config: { contextTokens: number; kvKeyType: string; kvValueType: string };
    };
    signal?: AbortSignal;
  }): Promise<number[][]>;
  disable(): Promise<void>;
  close(): Promise<void>;
  snapshot(): { pid: number | null; spawns: number; running: boolean };
  tryHoldLease(): Promise<boolean>;
  releaseLeaseHold(): Promise<void>;
  probe(
    runtime: {
      modelId: string;
      epoch: number;
      config: { contextTokens: number; kvKeyType: string; kvValueType: string };
    },
    options?: { timeoutMs?: number },
  ): Promise<{ peakRssBytes: number | null }>;
};
type Clock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
type Embedder = {
  embed(
    texts: readonly string[],
    options: { purpose: Purpose; signal?: AbortSignal },
  ): Promise<number[][]>;
  measureInputs?(
    texts: readonly string[],
    options: { signal?: AbortSignal },
  ): Promise<{ counts: number[]; limit: number }>;
};

/** A READY model epoch plus the admin runtime config it runs under. */
const rt = (epoch: number) => ({
  modelId: "qwen3-embedding-0.6b-q8_0",
  epoch,
  config: { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" } as const,
});
// Dynamic module URLs keep this composite TS project inside its root.
const lifecycle = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
)) as {
  createQwenSupervisor(options: Record<string, unknown>): Supervisor;
  createQwenEmbedder(deps: {
    supervisor: Pick<Supervisor, "embed">;
    readReadyRuntime: () => Promise<{
      modelId: string;
      epoch: number;
      config: { contextTokens: number; kvKeyType: string; kvValueType: string };
    } | null>;
  }): Embedder;
};
const probe = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-probe.ts", import.meta.url).href
)) as {
  probeQwenRuntime(
    options: Record<string, unknown>,
  ): Promise<{ dimensions: number; peakRssBytes: number | null }>;
};

const REPO = resolve(import.meta.dirname, "../../../..");
const CHILD = join(REPO, "apps/worker/dist/qwen-child.mjs");
const ARTIFACT = JSON.parse(
  readFileSync(join(REPO, "packages/api/src/lib/kb/fixtures/qwen-artifact.json"), "utf8"),
) as { modelId: string; sha256: string; sizeBytes: number; dimensions: number };
/** Each rt() fixture requests {4096, f16, f16}; the default-tier READY test is separate. */
const CONTEXT_TOKENS = 4096;
/** Spike inputs/token counts; archived vectors diagnose hardware drift, not batching. */
const REFERENCE = JSON.parse(
  readFileSync(join(import.meta.dirname, "qwen-batch-reference.json"), "utf8"),
) as {
  items: Array<{ id: string; purpose: Purpose; text: string; tokens: number; vector: number[] }>;
};
const MODEL = process.env.KB_QWEN_MODEL_PATH ?? "";

const DOCS = {
  sourdough:
    "To bake sourdough bread, feed the starter, mix flour, water and salt, let the dough rise overnight and bake it in a hot Dutch oven.",
  compiler:
    "The Rust compiler checks ownership and borrowing rules at compile time and reports lifetime errors before the program runs.",
  tides:
    "Ocean tides are caused mainly by the gravitational pull of the Moon, with a smaller contribution from the Sun.",
};
const QUERY = "how do I bake bread with a sourdough starter";
/** "a" + " a"*(n-1): one BPE token per word for this tokenizer. */
const tokens = (n: number) => `a${" a".repeat(n - 1)}`;

const dirs: string[] = [];
const supervisors: Supervisor[] = [];
let guard = "";

function tmp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function procState(pid: number): "gone" | "zombie" | "alive" {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z" ? "zombie" : "alive";
  } catch {
    return "gone";
  }
}

const ADDON = /@node-llama-cpp|libllama|llama-addon|libggml/;
const mapsAddon = (pid: number | "self") => ADDON.test(readFileSync(`/proc/${pid}/maps`, "utf8"));

function manualClock(): Clock & { fire(): void } {
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    setTimeout(fn) {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    fire() {
      for (const [key, fn] of [...timers]) {
        timers.delete(key);
        fn();
      }
    },
  };
}

async function until(check: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function make(extra: Record<string, unknown> = {}) {
  const clock = manualClock();
  const supervisor = lifecycle.createQwenSupervisor({
    guardPath: guard,
    childEntry: CHILD,
    modelPath: MODEL,
    clock,
    termGraceMs: 10_000,
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
    ...extra,
  });
  supervisors.push(supervisor);
  return { supervisor, clock };
}

const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
/** The raw-embedding contract against the shared recorded Qwen output (raw-embedding.ts). */
const indexUnit = (raw: number[]) => expectRawEmbedding(raw, ARTIFACT.modelId);
const round = (v: number) => Math.round(v * 1000) / 1000;

function llamaVersions() {
  const dir = realpathSync(join(REPO, "apps/worker/node_modules/node-llama-cpp"));
  const version = (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const nativeRuntime = JSON.parse(
    readFileSync(
      join(
        dir,
        "llama/localBuilds",
        JSON.parse(readFileSync(join(dir, "llama/lastBuild.json"), "utf8")).folderName,
        "Release/kb-runtime.json",
      ),
      "utf8",
    ),
  ).runtime;
  return { version, nativeRuntime };
}

beforeAll(() => {
  // Explicit lane prerequisites: fail, never skip.
  if (!MODEL) throw new Error("KB_QWEN_MODEL_PATH is required for the qwen-model lane.");
  const info = lstatSync(MODEL);
  if (!info.isFile() || info.size !== ARTIFACT.sizeBytes)
    throw new Error("Qwen model artifact is not the pinned regular file.");
  requireBuiltArtifact(CHILD, "pnpm test:kb --build-only qwen-model", false);
  guard = requireBuiltArtifact(
    buildArtifactPath("child-guard"),
    "pnpm test:kb --build-only qwen-model",
  );
});

afterEach(async () => {
  // Also restore on a Vitest wall-clock timeout, before closing/reaping children.
  vi.useRealTimers();
  for (const supervisor of supervisors.splice(0)) await supervisor.close().catch(() => {});
});

const indexDir = mkdtempSync(join(tmpdir(), "kb-qwen-model-index-"));
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it.each(["return", "throw"] as const)(
  "the inference clock freezes callback and absolute expiry, then restores real timers on %s",
  async (outcome) => {
    const failure = new Error("fixture failure");
    const run = modelInference(async () => {
      const now = Date.now();
      const expired = vi.fn();
      setTimeout(expired, 0);
      // A real event-loop turn models child IPC while the parent clock is frozen.
      await new Promise<void>((resolve) => realTimeout(resolve, 10));
      expect(expired).not.toHaveBeenCalled();
      expect(Date.now()).toBe(now);
      if (outcome === "throw") throw failure;
      return "complete";
    });
    if (outcome === "throw") await expect(run()).rejects.toBe(failure);
    else await expect(run()).resolves.toBe("complete");
    expect(vi.isFakeTimers()).toBe(false);
    // Restoration includes functioning timers, rather than just a fake-clock flag.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  },
);

describe("pinned artifact", () => {
  it("the cached artifact matches the pinned SHA-256 (tamper rejection: scripts/test-kb.test.mjs)", () => {
    // The runner already verified the full file; re-hash here so this file alone is sound.
    const hash = createHash("sha256");
    const fd = openSync(MODEL, "r");
    const buffer = Buffer.allocUnsafe(8 << 20);
    try {
      for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer))
        hash.update(buffer.subarray(0, n));
    } finally {
      closeSync(fd);
    }
    expect(hash.digest("hex")).toBe(ARTIFACT.sha256);
  });
});

describe("real model through the forked child", () => {
  it(
    "loads the patched CPU source build, embeds 1024-d finite unit vectors and ranks the fixture correctly; the parent stays addon-free",
    {
      timeout: 300_000,
    },
    modelInference(async () => {
      const { supervisor } = make();
      const names = Object.keys(DOCS);
      const docs = await supervisor.embed({
        purpose: "document",
        texts: Object.values(DOCS),
        runtime: rt(1),
      });
      const [query] = await supervisor.embed({ purpose: "query", texts: [QUERY], runtime: rt(1) });
      const pid = supervisor.snapshot().pid!;
      expect(procState(pid)).toBe("alive");
      const docUnits = docs.map(indexUnit);
      const queryUnit = indexUnit(query!);
      const scores = names
        .map((name, i) => ({ name, score: dot(queryUnit, docUnits[i]!) }))
        .sort((a, b) => b.score - a.score);
      expect(scores[0]!.name).toBe("sourdough");
      expect(scores[0]!.score).toBeGreaterThan(scores[1]!.score);
      // Native addon confinement, with a positive control on the child.
      expect(mapsAddon("self")).toBe(false);
      expect(mapsAddon(pid)).toBe(true);
      const versions = llamaVersions();
      console.log(
        `QWEN_HOST_EVIDENCE ${JSON.stringify({
          node: process.version,
          arch: process.arch,
          nodeLlamaCpp: versions.version,
          nativeRuntime: versions.nativeRuntime,
          dimensions: query!.length,
          scores: scores.map(({ name, score }) => ({ name, score: round(score) })),
        })}`,
      );
    }),
  );

  it(
    "context boundary: 4095 tokens + EOS fills the 4096 context and embeds; 4096 + EOS is EMBEDDING_INPUT_TOO_LONG with the child still alive",
    {
      timeout: 300_000,
    },
    modelInference(async () => {
      const { supervisor } = make();
      const [accepted] = await supervisor.embed({
        purpose: "document",
        texts: [tokens(CONTEXT_TOKENS - 1)],
        runtime: rt(1),
      });
      indexUnit(accepted!);
      const pid = supervisor.snapshot().pid!;
      await expect(
        supervisor.embed({
          purpose: "document",
          texts: [tokens(CONTEXT_TOKENS)],
          runtime: rt(1),
        }),
      ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LONG" });
      // Rejected before native execute: same live child, no crash/respawn.
      expect(supervisor.snapshot()).toMatchObject({ pid, spawns: 1 });
      expect(procState(pid)).toBe("alive");
      // The query prefix counts against the same context.
      await expect(
        supervisor.embed({
          purpose: "query",
          texts: [tokens(CONTEXT_TOKENS - 1)],
          runtime: rt(1),
        }),
      ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LONG" });
      expect(supervisor.snapshot()).toMatchObject({ pid, spawns: 1 });
      expect(procState(pid)).toBe("alive");
    }),
  );

  it("idle exit is observed by PID (/proc gone) and the next job reloads on a new PID with identical vectors", {
    timeout: 300_000,
  }, async () => {
    const { supervisor, clock } = make();
    const [first] = await modelInference(() =>
      supervisor.embed({ purpose: "query", texts: [QUERY], runtime: rt(1) }),
    )();
    const firstPid = supervisor.snapshot().pid!;
    clock.fire();
    await until(() => supervisor.snapshot().pid === null, 15_000, "idle shutdown");
    await until(() => procState(firstPid) === "gone", 5_000, "reaped child");
    const [again] = await modelInference(() =>
      supervisor.embed({ purpose: "query", texts: [QUERY], runtime: rt(1) }),
    )();
    const reloadPid = supervisor.snapshot().pid!;
    expect(reloadPid).not.toBe(firstPid);
    expect(supervisor.snapshot().spawns).toBe(2);
    const delta = Math.max(...again!.map((v, i) => Math.abs(v - first![i]!)));
    expect(delta).toBeLessThan(1e-4);
    expect(procState(process.pid)).toBe("alive");
  });

  it("disable fences a running real execution: the caller is rejected, the child is killed and reaped, the parent survives", {
    timeout: 300_000,
  }, async () => {
    const { supervisor } = make();
    await modelInference(() =>
      supervisor.embed({ purpose: "query", texts: ["warm"], runtime: rt(1) }),
    )();
    const pid = supervisor.snapshot().pid!;
    const running = supervisor.embed({
      purpose: "document",
      texts: [tokens(CONTEXT_TOKENS - 1)],
      runtime: rt(1),
    });
    // Attach the rejection handler before disable() rejects the running request.
    const fenced = expect(running).rejects.toMatchObject({ name: "QwenDisabledError" });
    await new Promise((r) => setTimeout(r, 50));
    await supervisor.disable();
    await fenced;
    expect(procState(pid)).toBe("gone");
    expect(procState(process.pid)).toBe("alive");
  });

  it(
    "a late result after the READY epoch changes is discarded by the embedder adapter",
    {
      timeout: 300_000,
    },
    modelInference(async () => {
      const { supervisor } = make();
      let epoch: number | null = 1;
      const embedder = lifecycle.createQwenEmbedder({
        supervisor: {
          embed: async (input) => {
            const vectors = await supervisor.embed(input);
            epoch = null; // admin disable lands while the child was computing
            return vectors;
          },
        },
        readReadyRuntime: async () => (epoch === null ? null : rt(epoch)),
      });
      await expect(embedder.embed([QUERY], { purpose: "query" })).rejects.toMatchObject({
        code: "INDEX_UNAVAILABLE",
      });
    }),
  );
});

describe("46r9 patched Qwen context tiers", () => {
  // These measurements assert full-context memory, not idle-host CPU speed.
  // The unchanged two-minute product deadline is pinned separately with virtual
  // time in qwen-lifecycle.test.ts, including a result just before expiry.
  it.each([1024, 2048, 4096, 8192])(
    "max-context %i-token probe stays under the patched memory envelope",
    { timeout: 1_260_000 },
    modelInference(async (contextTokens: number) => {
      const { supervisor } = make();
      const config = { contextTokens, kvKeyType: "f16", kvValueType: "f16" } as const;
      const result = await supervisor.probe(
        { modelId: ARTIFACT.modelId, epoch: 1, config },
        { timeoutMs: 1_200_000 },
      );
      expect(result.peakRssBytes).toBeGreaterThan(0);
      expect(result.peakRssBytes).toBeLessThan(estimateBuiltinPeakBytes(QWEN_MODEL, config));
      console.log(
        `QWEN_PATCHED_TIER ${JSON.stringify({ contextTokens, peakRssBytes: result.peakRssBytes, estimate: estimateBuiltinPeakBytes(QWEN_MODEL, config) })}`,
      );
    }),
  );
});

describe("memory-aware runtime", () => {
  it(
    "a near-limit 4096-context input decodes in 512-token batches with child peak RSS < 2.5 GiB at f16/f16",
    {
      timeout: 600_000,
    },
    modelInference(async () => {
      const peaks: number[] = [];
      const { supervisor } = make({ onPeakRss: (bytes: number) => peaks.push(bytes) });
      // 4085 tokens + EOS: the near-limit input that drove the old full-batch child past 5.6 GiB.
      const [vector] = await supervisor.embed({
        purpose: "document",
        texts: [tokens(CONTEXT_TOKENS - 11)],
        runtime: rt(1),
      });
      expect(vector).toHaveLength(ARTIFACT.dimensions);
      const pid = supervisor.snapshot().pid!;
      // Independent evidence: the kernel's VmHWM for the live child process.
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const hwm = Number(/^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1]) * 1024;
      const limit = 2.5 * 1024 ** 3;
      expect(hwm).toBeGreaterThan(0);
      expect(hwm).toBeLessThan(limit);
      // The child reported the same peak through IPC (what the admin panel shows).
      expect(peaks.at(-1)).toBeGreaterThan(0);
      expect(peaks.at(-1)!).toBeLessThan(limit);
      console.log(`QWEN_NEAR_LIMIT_PEAK ${JSON.stringify({ hwmMiB: Math.round(hwm / 1048576) })}`);
    }),
  );

  it(
    "batch-512 vectors equal a same-hardware single-batch reference on the spike fixtures (cosine >= 0.99999)",
    {
      timeout: 600_000,
    },
    modelInference(async () => {
      // Different CPU attention/quantization kernels need not reproduce the old
      // development host's vectors. Only batch size differs in this comparison;
      // neither the pooling/tokenization contract nor the tolerance is relaxed.
      const reference = JSON.parse(
        execFileSync(
          guard,
          [
            String(process.pid),
            process.execPath,
            join(REPO, "apps/worker/qwen-reference.fixture.mjs"),
            MODEL,
            join(import.meta.dirname, "qwen-batch-reference.json"),
            join(REPO, "packages/api/src/lib/kb/fixtures/qwen-artifact.json"),
          ],
          {
            env: { PATH: process.env.PATH, HOME: process.env.HOME },
            encoding: "utf8",
            timeout: 300_000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      ) as {
        arch: string;
        generationTokens: number[];
        items: Array<{ id: string; tokens: number; vector: number[] }>;
      };
      expect(reference.arch).toBe(process.arch);
      // The pooled-only patch must preserve ordinary LM logits and sampling.
      expect(reference.generationTokens).toHaveLength(3);
      expect(
        reference.generationTokens.every((token) => Number.isInteger(token) && token >= 0),
      ).toBe(true);
      expect(reference.items.map((item) => item.id)).toEqual(
        REFERENCE.items.map((item) => item.id),
      );
      expect(mapsAddon("self")).toBe(false);
      const { supervisor } = make();
      let minCosine = 1;
      let archivedMinCosine = 1;
      for (const [i, item] of REFERENCE.items.entries()) {
        const [vector] = await supervisor.embed({
          purpose: item.purpose,
          texts: [item.text],
          runtime: rt(1),
        });
        const fullBatch = reference.items[i]!;
        expect(fullBatch.tokens).toBe(item.tokens);
        expect(fullBatch.vector).toHaveLength(ARTIFACT.dimensions);
        expect(fullBatch.vector.every(Number.isFinite)).toBe(true);
        expect(Math.abs(Math.hypot(...fullBatch.vector) - 1)).toBeLessThan(1e-3);
        // The references are unit vectors; the live output is raw.
        const unit = indexUnit(vector!);
        const cosine = dot(unit, fullBatch.vector);
        minCosine = Math.min(minCosine, cosine);
        archivedMinCosine = Math.min(archivedMinCosine, dot(unit, item.vector));
        expect(cosine, item.id).toBeGreaterThanOrEqual(0.99999);
      }
      // The long item spans four 512-token batches; the short ones one.
      expect(REFERENCE.items.find((item) => item.id === "long")!.tokens).toBeGreaterThan(1536);
      console.log(`QWEN_BATCH_REFERENCE ${JSON.stringify({ minCosine, archivedMinCosine })}`);
    }),
  );
});

describe("runtime capability probe (READY gate)", () => {
  it(
    "passes at the smallest tier on the real artifact and leaves no model process behind",
    {
      timeout: 300_000,
    },
    modelInference(async () => {
      const pids: number[] = [];
      const result = await probe.probeQwenRuntime({
        modelId: ARTIFACT.modelId,
        spawn: (...args: Parameters<typeof spawn>) => {
          const child = spawn(...args);
          if (child.pid) pids.push(child.pid);
          return child;
        },
        childEntry: CHILD,
        modelPath: MODEL,
        guardPath: guard,
        config: { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" },
      });
      expect(result).toMatchObject({ dimensions: ARTIFACT.dimensions });
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(procState(pid)).toBe("gone");
      // The probe records the child's real peak RSS (VmHWM) under the configured runtime.
      expect((result as { peakRssBytes: number }).peakRssBytes).toBeGreaterThan(512 * 1024 ** 2);
      expect(mapsAddon("self")).toBe(false);
    }),
  );

  it("a file the native runtime cannot load is MODEL_RUNTIME_UNSUPPORTED", {
    timeout: 120_000,
  }, async () => {
    const bogus = join(tmp("kb-qwen-bogus-"), "model.gguf");
    writeFileSync(bogus, Buffer.from("GGUF-not-really".repeat(64)));
    await expect(
      probe.probeQwenRuntime({
        modelId: ARTIFACT.modelId,
        childEntry: CHILD,
        modelPath: bogus,
        guardPath: guard,
        config: rt(0).config,
      }),
    ).rejects.toMatchObject({ code: "MODEL_RUNTIME_UNSUPPORTED" });
  });

  it("a missing guard binary (dev outside the image) is MODEL_RUNTIME_UNSUPPORTED", async () => {
    await expect(
      probe.probeQwenRuntime({
        modelId: ARTIFACT.modelId,
        childEntry: CHILD,
        modelPath: MODEL,
        guardPath: join(dirname(guard), "absent-guard"),
        config: rt(0).config,
      }),
    ).rejects.toMatchObject({ code: "MODEL_RUNTIME_UNSUPPORTED" });
  });
});

describe("config load probe and context-fit chunking", () => {
  const ctx1k = {
    modelId: ARTIFACT.modelId,
    epoch: 1,
    config: { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" },
  } as const;

  it(
    "a candidate config is load-probed in its own child with one max-context embedding; an unloadable one fails; nothing is left behind",
    {
      timeout: 300_000,
    },
    modelInference(async () => {
      const { supervisor } = make();
      expect(await supervisor.tryHoldLease()).toBe(true);
      const result = await supervisor.probe(ctx1k, { timeoutMs: 120_000 });
      expect(result.peakRssBytes).toBeGreaterThan(512 * 1024 ** 2);
      // The probe child is reaped and never becomes the serving child.
      expect(supervisor.snapshot().pid).toBeNull();
      await supervisor.releaseLeaseHold();

      const bogus = join(tmp("kb-qwen-probe-bogus-"), "model.gguf");
      writeFileSync(bogus, Buffer.from("GGUF-not-really".repeat(64)));
      const { supervisor: broken } = make({ modelPath: bogus });
      await broken.tryHoldLease();
      await expect(broken.probe(ctx1k, { timeoutMs: 60_000 })).rejects.toMatchObject({
        code: "MODEL_CONFIG_PROBE_FAILED",
      });
      expect(broken.snapshot().pid).toBeNull();
      await broken.releaseLeaseHold();
      expect(mapsAddon("self")).toBe(false);
    }),
  );

  it("at contextTokens 1024 a dense 400-word document fits: every piece (model tokens incl. EOS) <= 1024, overlapping, exact offsets, builds and activates with native inference", {
    timeout: 600_000,
  }, async () => {
    const { supervisor } = make();
    const embedder = lifecycle.createQwenEmbedder({
      supervisor,
      readReadyRuntime: async () => ctx1k,
    });
    const measure = embedder.measureInputs ? modelInference(embedder.measureInputs) : undefined;
    if (!measure) throw new Error("the built-in embedder must measure inputs");
    // Dense: identifier-like words that split into many subword tokens each.
    const words = Array.from(
      { length: 400 },
      (_, i) => `x${(i * 2654435761).toString(36)}Qz${(i * 40503).toString(16)}_${i}`,
    );
    const body = `${words.join(" ")}\n`;
    const base = chunkBody(body);
    expect(base.chunks).toHaveLength(1);
    const whole = await measure([base.chunks[0]!.text], {});
    expect(whole.limit).toBe(1024);
    expect(whole.counts[0]).toBeGreaterThan(1024); // does not fit as one window
    const fitted = await fitChunksToContext(body, base, (texts) => measure(texts, {}));
    expect(fitted.chunks.length).toBeGreaterThan(1);
    const recount = await measure(
      fitted.chunks.map((c) => c.text),
      {},
    );
    for (const count of recount.counts) expect(count).toBeLessThanOrEqual(1024);
    const bytes = Buffer.from(body, "utf8");
    for (const [i, chunk] of fitted.chunks.entries()) {
      expect(
        bytes
          .subarray(chunk.span.startByte, chunk.span.endByte)
          .toString("utf8")
          .replace(/\s+/g, " "),
      ).toBe(chunk.text);
      if (i > 0) expect(chunk.span.startByte).toBeLessThan(fitted.chunks[i - 1]!.span.endByte);
    }
    // Exercise the actual builder, including its request granularity, storage,
    // job heartbeat, DDL and activation. No fixture replaces native inference.
    const cluster = await openKbPostgresClusterFromEnv();
    const db = await cluster.createDatabase();
    const prisma = db.createPrismaClient("runtime");
    try {
      db.applyPrismaSchema();

      const reposDir = tmp("kb-qwen-native-build-");
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
      const job = await prisma.durableJob.create({
        data: { kind: "DOWNLOAD_MODEL", desired: {}, dedupKey: randomUUID(), state: "COMPLETE" },
      });
      await prisma.localModel.create({
        data: {
          id: QWEN_MODEL_ID,
          state: "READY",
          runtimeIdentity: qwenModelIdentity(),
          epoch: ctx1k.epoch,
          ...ctx1k.config,
          jobId: job.id,
        },
      });
      await runtime.coordinator.run({
        opId: randomUUID(),
        kind: "authority",
        run: ({ lease }) =>
          lease.transaction((q) =>
            ensureSystemBuiltinProvider(q, job.id, ctx1k.config, ARTIFACT.modelId),
          ),
      });
      const owner = await prisma.user.create({
        data: {
          name: "Native fixture",
          email: `${randomUUID()}@example.invalid`,
          emailVerified: true,
          twoFactorEnabled: true,
        },
      });
      const kbId = `n${randomUUID().replaceAll("-", "").slice(0, 23)}`;
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
      execFileSync("git", ["init", "--bare", repo], { env, stdio: "ignore" });
      const git = (args: string[], input?: string) =>
        execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8" }).trim();
      const blob = (text: string) => git(["hash-object", "-w", "--stdin"], text);
      const assets = git(
        ["mktree"],
        `100644 blob ${blob('{"version":1,"entries":[]}\n')}\tmanifest.json\n`,
      );
      const tree = git(
        ["mktree"],
        `040000 tree ${assets}\t.assets\n100644 blob ${blob(body)}\tdense.md\n`,
      );
      const sha = git(["commit-tree", tree, "-m", "fixture"]);
      git(["update-ref", "refs/heads/main", sha]);
      await prisma.knowledgeBase.create({
        data: {
          id: kbId,
          ownerId: owner.id,
          name: "Dense native",
          slug: kbId,
          description: "Dense native build fixture",
          state: "ACTIVE",
          headSha: sha,
        },
      });
      const build = await requestIndexBuild(
        runtime,
        { principal: { kind: "browser", userId: owner.id } },
        {
          kbId,
          providerId: SYSTEM_BUILTIN_PROVIDER_ID,
          revision: 1,
          idempotencyKey: randomUUID().replaceAll("-", ""),
          confirm: "RUN",
        },
      );
      // Publication is fixture setup; production claims/fences the real job.
      await prisma.durableJob.update({ where: { id: build.jobId }, data: { state: "PUBLISHED" } });
      const batchSizes: number[] = [];
      const observed: IndexEmbedder = {
        measureInputs: measure,
        embed: (texts, options) => {
          batchSizes.push(texts.length);
          return modelInference(() => embedder.embed(texts, options))();
        },
      };
      await deliverIndexBuild(prisma, {
        connectionString: db.urls.runtime,
        indexDir,
        reposDir,
        masterKey: undefined,
        workerId: randomUUID(),
        durableJobId: build.jobId,
        qwenEmbedder: observed,
      });
      expect(batchSizes).toEqual(fitted.chunks.map(() => 1));
      const generation = await prisma.indexGeneration.findUniqueOrThrow({
        where: { id: build.generationId },
      });
      expect(generation).toMatchObject({
        state: "COMPLETE",
        fingerprint: qwenEmbeddingFingerprint(ctx1k.config),
        chunkCount: fitted.chunks.length,
      });
      expect(await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } })).toMatchObject({
        activeGenerationId: generation.id,
      });
      const stored = readIndexFile(generationFilePath(indexDir, kbId, generation.id));
      expect(stored.meta.dimensions).toBe(ARTIFACT.dimensions);
      expect(stored.vectors).toBe(fitted.chunks.length);
      expect(stored.chunks.map(({ text, chunkIndex }) => ({ text, chunkIndex }))).toEqual(
        fitted.chunks.map((chunk) => ({ text: chunk.text, chunkIndex: chunk.chunkIndex })),
      );
      // Inverse: a single-piece admission still aborts real native execution,
      // drains before rejection, and permits a healthy successor on a new child.
      const pid = supervisor.snapshot().pid!;
      expect(procState(pid)).toBe("alive");
      const controller = new AbortController();
      const cancelled = expect(
        embedder.embed([fitted.chunks[0]!.text], {
          purpose: "document",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
      await until(() => supervisor.snapshot().running, 5_000, "native document admission");
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      await cancelled;
      expect(procState(pid)).toBe("gone");
      const [successor] = await modelInference(() =>
        embedder.embed(["successor"], { purpose: "document" }),
      )();
      expect(successor).toHaveLength(ARTIFACT.dimensions);
      const nextPid = supervisor.snapshot().pid!;
      expect(nextPid).not.toBe(pid);
      await supervisor.close();
      expect(procState(nextPid)).toBe("gone");
    } finally {
      await supervisor.close();
      await prisma.$disconnect();
      await db.close();
      await cluster.close();
    }
    console.log(
      `QWEN_CONTEXT_FIT ${JSON.stringify({ pieces: fitted.chunks.length, max: Math.max(...recount.counts), whole: whole.counts[0] })}`,
    );
  });
});
