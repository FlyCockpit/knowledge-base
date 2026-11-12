/** R46: actual owned PostgreSQL I/O, with native inference deliberately unreachable or stubbed. */

import { connect, createServer, type Socket } from "node:net";
import { GEMMA_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import { EmbeddingUnavailableError } from "@knowledge-base/api/lib/kb/embed-client";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import { builtinModelIdentity } from "@knowledge-base/api/lib/kb/fingerprint";
import {
  type ModelRuntimeIo,
  QWEN_MODEL_ID,
  readModelRuntimeConfig,
  readReadyModelRuntime,
  recordModelPeakRss,
  recordWorkerMemoryBudget,
} from "@knowledge-base/api/lib/kb/local-model";
import { captureLog } from "@knowledge-base/env/log";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openKbPostgresClusterFromEnv } from "./postgres";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
type Runtime = NonNullable<Awaited<ReturnType<typeof readReadyModelRuntime>>>;
const { createQwenEmbedder, watchQwenModelRuntime } = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
)) as {
  createQwenEmbedder(deps: {
    supervisor: {
      embed(): Promise<number[][]>;
      countTokens(): Promise<{ counts: number[]; limit: number }>;
    };
    readReadyRuntime(io: ModelRuntimeIo): Promise<Runtime | null>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Embedder;
  watchQwenModelRuntime(
    supervisor: {
      snapshot(): { pid: number | null };
      loadedRuntime(): Runtime | null;
      disable(): Promise<void>;
    },
    read: (io: ModelRuntimeIo) => Promise<Runtime | null>,
    intervalMs?: number,
  ): () => Promise<void>;
};
const { verifyQwenRuntime } = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-probe.ts", import.meta.url).href
)) as {
  verifyQwenRuntime(options: {
    connectionString: string;
    modelId: string;
    modelPath: string;
    childEntry: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    spawn: () => never;
  }): Promise<unknown>;
};
const { createQwenPeakReporter, startQwenRuntimeLoops } = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-runtime-loops.ts", import.meta.url).href
)) as {
  createQwenPeakReporter(deps: {
    signal: AbortSignal;
    write(bytes: number, runtime: Runtime, signal: AbortSignal): Promise<void>;
    track(task: Promise<void>): void;
  }): (bytes: number, runtime: Runtime) => void;
  startQwenRuntimeLoops(deps: {
    detectBudget(): typeof budget;
    reportBudget(value: typeof budget, signal: AbortSignal): Promise<void>;
    hasWork(): Promise<boolean>;
    advance(): Promise<void>;
    reembedIntervalMs: number;
    budgetIntervalMs: number;
  }): () => Promise<void>;
};

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const runtime = { connectionString: db.urls.runtime };
const budget = {
  budgetBytes: 8 * 1024 ** 3,
  availableBytes: 7 * 1024 ** 3,
  source: "meminfo" as const,
};
afterAll(async () => {
  await db.close();
  await cluster.close();
});

async function ready() {
  await recordWorkerMemoryBudget(runtime, budget);
  await db.query(
    "applier",
    `UPDATE kb_local_model SET state='READY',epoch=1,"modelId"=$2,"runtimeIdentity"=$3 WHERE id=$1`,
    [QWEN_MODEL_ID, GEMMA_MODEL.modelId, builtinModelIdentity(GEMMA_MODEL)],
  );
  return (await readReadyModelRuntime(runtime))!;
}
async function lockModel() {
  const client = new Client({ connectionString: db.urls.applier });
  await client.connect();
  await client.query("BEGIN");
  await client.query("LOCK TABLE kb_local_model IN ACCESS EXCLUSIVE MODE");
  return async () => {
    await client.query("ROLLBACK");
    await client.end();
  };
}
async function blockedCount() {
  const result = await db.query(
    "runtime",
    `SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND application_name LIKE 'kb-model-io-%'
      AND wait_event_type='Lock' AND query LIKE '%kb_local_model%'`,
  );
  return Number(result.rows[0]?.n);
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("R46 model runtime I/O", () => {
  it("empty state stays disabled; a successful budget report preserves the default configuration", async () => {
    expect(await readReadyModelRuntime(runtime)).toBeNull();
    expect(await readModelRuntimeConfig(runtime)).toMatchObject({
      modelId: GEMMA_MODEL.modelId,
      contextTokens: 1024,
    });
    await recordWorkerMemoryBudget(runtime, budget);
    expect(await readReadyModelRuntime(runtime)).toBeNull();
    const state = await ready();
    await recordModelPeakRss(runtime, { bytes: 1234, ...state });
    expect(
      (
        await db.query(
          "runtime",
          `SELECT "memoryBudgetBytes","peakRssBytes" FROM kb_local_model WHERE id=$1`,
          [QWEN_MODEL_ID],
        )
      ).rows[0],
    ).toMatchObject({ memoryBudgetBytes: String(budget.budgetBytes), peakRssBytes: "1234" });
  });

  it("pre-cancelled reads, reports and verifier do no I/O or native dispatch", async () => {
    const io = { signal: AbortSignal.abort() };
    for (const run of [
      () => readReadyModelRuntime({ connectionString: "invalid" }, io),
      () => readModelRuntimeConfig({ connectionString: "invalid" }, io),
      () => recordWorkerMemoryBudget({ connectionString: "invalid" }, budget, io),
      () =>
        recordModelPeakRss({ connectionString: "invalid" }, { bytes: 1, ...awaitedRuntime() }, io),
    ])
      await expect(run()).rejects.toBeDefined();
    const read = vi.fn(() => readReadyModelRuntime(runtime));
    const embed = vi.fn(async () => [[1]]);
    const adapter = createQwenEmbedder({
      supervisor: { embed, countTokens: async () => ({ counts: [1], limit: 1024 }) },
      readReadyRuntime: read,
    });
    await expect(
      adapter.embed(["x"], { purpose: "query", signal: io.signal }),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await expect(adapter.measureInputs!(["x"], io)).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
    expect(read).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    const spawn = vi.fn((): never => {
      throw new Error("native dispatch forbidden");
    });
    await expect(
      verifyQwenRuntime({
        ...runtime,
        ...io,
        modelId: GEMMA_MODEL.modelId,
        modelPath: "/unused",
        childEntry: "/unused",
        spawn,
      }),
    ).rejects.toBeDefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["query", "document", "measure"] as const)(
    "cancels and joins blocked %s readiness before and after inference; successor works",
    async (kind) => {
      await ready();
      for (const stage of ["before", "after"] as const) {
        let unlock: (() => Promise<void>) | undefined;
        const controller = new AbortController();
        let inference = 0;
        const infer = async () => {
          inference++;
          if (stage === "after") unlock = await lockModel();
        };
        const adapter = createQwenEmbedder({
          supervisor: {
            embed: async () => {
              await infer();
              return [[1]];
            },
            countTokens: async () => {
              await infer();
              return { counts: [1], limit: 1024 };
            },
          },
          readReadyRuntime: (io) => readReadyModelRuntime(runtime, io),
        });
        if (stage === "before") unlock = await lockModel();
        const call = () =>
          kind === "measure"
            ? adapter.measureInputs!(["x"], { signal: controller.signal })
            : adapter.embed(["x"], { purpose: kind, signal: controller.signal });
        const run = call();
        const rejected = expect(run).rejects.toBeInstanceOf(EmbeddingUnavailableError);
        try {
          await until(async () => (await blockedCount()) === 1, `${stage} read waiting`);
          expect(inference).toBe(stage === "before" ? 0 : 1);
          const cancelledAt = Date.now();
          controller.abort();
          await rejected;
          expect(Date.now() - cancelledAt).toBeLessThan(3000);
          // The blocker is still held: disappearing SQL proves joined cancellation, not unlock.
          expect(await blockedCount()).toBe(0);
        } finally {
          controller.abort();
          await unlock?.();
          await run.catch(() => {});
        }
        const healthy = createQwenEmbedder({
          supervisor: {
            embed: async () => [[1]],
            countTokens: async () => ({ counts: [1], limit: 1024 }),
          },
          readReadyRuntime: (io) => readReadyModelRuntime(runtime, io),
        });
        expect(
          kind === "measure"
            ? await healthy.measureInputs!(["x"], {})
            : await healthy.embed(["x"], { purpose: kind }),
        ).toBeDefined();
      }
    },
  );

  it("omitted SQL timeout is bounded and the adapter's final read uses the remaining budget", async () => {
    await ready();
    let unlock = await lockModel();
    const read = readReadyModelRuntime(runtime);
    const rejected = expect(read).rejects.toBeDefined();
    try {
      await until(async () => (await blockedCount()) === 1, "default read waiting");
      await rejected;
      expect(await blockedCount()).toBe(0);
    } finally {
      await unlock();
      await read.catch(() => {});
    }
    const deadlines: number[] = [];
    const adapter = createQwenEmbedder({
      timeoutMs: 500,
      supervisor: {
        embed: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          unlock = await lockModel();
          return [[1]];
        },
        countTokens: async () => ({ counts: [1], limit: 1024 }),
      },
      readReadyRuntime: (io) => {
        deadlines.push(io.deadlineAt!);
        return readReadyModelRuntime(runtime, io);
      },
    });
    const start = Date.now();
    const run = adapter.embed(["x"], { purpose: "query" });
    try {
      await expect(run).rejects.toBeInstanceOf(EmbeddingUnavailableError);
      expect(deadlines).toHaveLength(2);
      expect(deadlines[1]).toBe(deadlines[0]);
      expect(Date.now() - start).toBeLessThan(3000);
      expect(await blockedCount()).toBe(0);
    } finally {
      await unlock();
      await run.catch(() => {});
    }
  });

  it("worker shutdown cancels document readiness before native admission and seals the adapter", async () => {
    await ready();
    const unlock = await lockModel();
    const shutdown = new AbortController();
    const embed = vi.fn(async () => [[1]]);
    const adapter = createQwenEmbedder({
      signal: shutdown.signal,
      supervisor: { embed, countTokens: async () => ({ counts: [1], limit: 1024 }) },
      readReadyRuntime: (io) => readReadyModelRuntime(runtime, io),
    });
    const run = adapter.embed(["x"], { purpose: "document" });
    const rejected = expect(run).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    try {
      await until(async () => (await blockedCount()) === 1, "worker document read waiting");
      shutdown.abort();
      await rejected;
      expect(await blockedCount()).toBe(0);
      expect(embed).not.toHaveBeenCalled();
      await expect(adapter.measureInputs!(["x"], {})).rejects.toBeInstanceOf(
        EmbeddingUnavailableError,
      );
      expect(await blockedCount()).toBe(0);
    } finally {
      shutdown.abort();
      await unlock();
      await run.catch(() => {});
    }
  });

  it("enable verification cancels a blocked configuration read before spawning", async () => {
    await ready();
    const unlock = await lockModel();
    const controller = new AbortController();
    const spawn = vi.fn((): never => {
      throw new Error("must not spawn");
    });
    const run = verifyQwenRuntime({
      ...runtime,
      modelId: GEMMA_MODEL.modelId,
      modelPath: "/unused",
      childEntry: "/unused",
      signal: controller.signal,
      spawn,
    });
    const rejected = expect(run).rejects.toBeDefined();
    try {
      await until(async () => (await blockedCount()) === 1, "config read waiting");
      controller.abort();
      await rejected;
      expect(await blockedCount()).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await unlock();
      await run.catch(() => {});
    }
    expect(await readModelRuntimeConfig(runtime)).toMatchObject({ modelId: GEMMA_MODEL.modelId });
  });

  it("lost transport replies and cancellation acknowledgements cannot strand model SQL", async () => {
    await ready();
    const destination = new URL(db.urls.runtime);
    const upstream = { port: Number(destination.port), host: destination.hostname };
    const sockets = new Set<Socket>();
    let dropReplies = false;
    const server = createServer((incoming) => {
      const outgoing = connect(upstream);
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => {
          sockets.delete(socket);
          incoming.destroy();
          outgoing.destroy();
        });
      }
      incoming.pipe(outgoing);
      outgoing.on("data", (data) => {
        if (!dropReplies) incoming.write(data);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("proxy address");
    destination.port = String(address.port);
    const unlock = await lockModel();
    const controller = new AbortController();
    const read = readReadyModelRuntime(
      { connectionString: destination.href },
      { signal: controller.signal, timeoutMs: 500 },
    );
    const rejected = expect(read).rejects.toBeDefined();
    try {
      await until(async () => (await blockedCount()) === 1, "proxied read waiting");
      dropReplies = true;
      controller.abort();
      await rejected;
      expect(await blockedCount()).toBe(0);
    } finally {
      controller.abort();
      await unlock();
      await read.catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(await readReadyModelRuntime(runtime)).toBeDefined();
  });

  it("native peak reports coalesce at the real SQL boundary and join shutdown", async () => {
    const loaded = await ready();
    const unlock = await lockModel();
    const shutdown = new AbortController();
    const tasks: Promise<void>[] = [];
    let writes = 0;
    const report = createQwenPeakReporter({
      signal: shutdown.signal,
      track: (work) => tasks.push(work),
      write: async (bytes, state, signal) => {
        writes++;
        await recordModelPeakRss(runtime, { bytes, ...state }, { signal });
      },
    });
    report(2000, loaded);
    for (let bytes = 2001; bytes <= 2100; bytes++) report(bytes, loaded);
    try {
      await until(async () => (await blockedCount()) === 1, "peak waiting");
      expect(writes).toBe(1);
      expect(tasks).toHaveLength(1);
      shutdown.abort();
      await Promise.all(tasks);
      expect(await blockedCount()).toBe(0);
      report(3000, loaded);
      expect(writes).toBe(1);
    } finally {
      shutdown.abort();
      await Promise.all(tasks);
      await unlock();
    }
    await recordModelPeakRss(runtime, { bytes: 3000, ...loaded });
    expect(
      (
        await db.query("runtime", `SELECT "peakRssBytes" FROM kb_local_model WHERE id=$1`, [
          QWEN_MODEL_ID,
        ])
      ).rows[0]?.peakRssBytes,
    ).toBe("3000");
  });

  it("watch stop cancels SQL, joins revocation, closes admission and permits a healthy watch", async () => {
    const loaded = await ready();
    const unlock = await lockModel();
    const disable = vi.fn(async () => {});
    let reads = 0;
    const supervisor = { snapshot: () => ({ pid: 42 }), loadedRuntime: () => loaded, disable };
    const stop = watchQwenModelRuntime(
      supervisor,
      (io) => {
        reads++;
        return readReadyModelRuntime(runtime, io);
      },
      20,
    );
    try {
      await until(async () => (await blockedCount()) === 1, "watch read waiting");
      await stop();
      expect(await blockedCount()).toBe(0);
      expect(disable).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 80));
      expect(reads).toBe(1);
    } finally {
      await stop();
      await unlock();
    }
    disable.mockClear();
    let healthyReads = 0;
    const healthy = Promise.withResolvers<void>();
    const successor = watchQwenModelRuntime(
      supervisor,
      async (io) => {
        try {
          const state = await readReadyModelRuntime(runtime, io);
          expect(state).toEqual(loaded);
          if (++healthyReads === 2) healthy.resolve();
          return state;
        } catch (error) {
          healthy.reject(error);
          throw error;
        }
      },
      20,
    );
    try {
      await healthy.promise;
      expect(healthyReads).toBeGreaterThanOrEqual(2);
      expect(disable).not.toHaveBeenCalled();
    } finally {
      await successor();
    }
  });

  it("watch stop drains SQL connection startup before joining revocation", async () => {
    // Withhold PostgreSQL's startup reply. pg.connect() remains pending even
    // after pg.end() closes this socket; stop must join the actual end event.
    const startup = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const revoking = Promise.withResolvers<void>();
    const revoked = Promise.withResolvers<void>();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("data", () => startup.resolve());
      socket.once("close", () => {
        sockets.delete(socket);
        closed.resolve();
      });
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("startup server address");
    const destination = new URL(db.urls.runtime);
    destination.port = String(address.port);
    const disable = vi.fn(() => {
      revoking.resolve();
      return revoked.promise;
    });
    let reads = 0;
    const stop = watchQwenModelRuntime(
      { snapshot: () => ({ pid: 42 }), loadedRuntime: awaitedRuntime, disable },
      (io) => {
        reads++;
        return readReadyModelRuntime({ connectionString: destination.href }, io);
      },
      20,
    );
    let stopped = false;
    let drain: Promise<void> | undefined;
    try {
      await startup.promise;
      drain = stop().then(() => {
        stopped = true;
      });
      await closed.promise;
      await revoking.promise;
      expect(disable).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
      expect(sockets.size).toBe(0);
      expect(reads).toBe(1);
      revoked.resolve();
      await drain;
      expect(stopped).toBe(true);
      await stop();
      expect(reads).toBe(1);
    } finally {
      revoked.resolve();
      for (const socket of sockets) socket.destroy();
      await stop();
      await drain;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("blocked memory writes stay single-flight, recover after timeout and drain on shutdown", async () => {
    await ready();
    let unlock = await lockModel();
    let started = 0;
    let succeeded = 0;
    const logged = captureLog();
    const stop = startQwenRuntimeLoops({
      detectBudget: () => budget,
      reportBudget: async (value, signal) => {
        started++;
        await recordWorkerMemoryBudget(runtime, value, { signal, timeoutMs: 500 });
        succeeded++;
      },
      hasWork: async () => false,
      advance: async () => {},
      budgetIntervalMs: 20,
      reembedIntervalMs: 60_000,
    });
    try {
      await until(async () => (await blockedCount()) === 1, "report waiting");
      await new Promise((r) => setTimeout(r, 200));
      expect(started).toBe(1);
      expect(succeeded).toBe(0);
      expect(await blockedCount()).toBe(1);
      await until(
        async () => logged.records.some((r) => r.site === "qwen.memory-report"),
        "report timeout",
      );
      await unlock();
      unlock = async () => {};
      await until(async () => succeeded >= 1, "healthy future report");
      expect(started).toBeGreaterThanOrEqual(2);
      unlock = await lockModel();
      await until(async () => (await blockedCount()) === 1, "next blocked report");
      await stop();
      expect(await blockedCount()).toBe(0);
      const admitted = started;
      await new Promise((r) => setTimeout(r, 100));
      expect(started).toBe(admitted);
    } finally {
      await stop();
      await unlock();
      logged.restore();
    }
    await recordWorkerMemoryBudget(runtime, { ...budget, availableBytes: 1234 });
    expect(
      (
        await db.query("runtime", `SELECT "memoryAvailableBytes" FROM kb_local_model WHERE id=$1`, [
          QWEN_MODEL_ID,
        ])
      ).rows[0]?.memoryAvailableBytes,
    ).toBe("1234");
  });
});

function awaitedRuntime(): Runtime {
  return {
    modelId: GEMMA_MODEL.modelId,
    epoch: 1,
    config: { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" },
  };
}
