import { EventEmitter } from "node:events";
import { QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import {
  EmbedderCallError,
  EmbeddingInputTooLongError,
  EmbeddingUnavailableError,
} from "@knowledge-base/api/lib/kb/embed-client";
import { describe, expect, it, vi } from "vitest";
import type { ParentToChild } from "./qwen-child";
import {
  createQwenEmbedder,
  createQwenSupervisor,
  QWEN_IDLE_MS,
  QWEN_MAX_WAITING,
  QWEN_QUERY_BURST,
  QwenChildCrashedError,
  type QwenChildHandle,
  QwenDisabledError,
  QwenProbeError,
  QwenQueueFullError,
  type QwenSupervisorOptions,
  QwenVolumeBusyError,
  watchQwenModelRuntime,
} from "./qwen-lifecycle";

const DIMS = 1024;
const DEFAULT = { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" } as const;
/** A READY model epoch plus the admin runtime config it runs under. */
const rt = (
  epoch: number,
  config: {
    contextTokens: 4096 | 8192 | 32768;
    kvKeyType: "f16" | "q8_0";
    kvValueType: "f16" | "q8_0" | "q4_0";
  } = DEFAULT,
) => ({ modelId: QWEN_MODEL.modelId, epoch, config });
const vec = (lead = 3) => Array.from({ length: DIMS }, (_, i) => (i === 0 ? lead : 0));

let nextPid = 40_000;
class FakeChild extends EventEmitter implements QwenChildHandle {
  pid = nextPid++;
  sent: ParentToChild[] = [];
  signals: string[] = [];
  exited = false;
  constructor(
    readonly behavior: { autoReady?: boolean; obeyShutdown?: boolean; ignoreTerm?: boolean } = {},
  ) {
    super();
    if (behavior.autoReady !== false) queueMicrotask(() => this.emit("message", { t: "ready" }));
  }
  send(message: ParentToChild) {
    if (this.exited) throw new Error("channel closed");
    this.sent.push(message);
    if (message.t === "shutdown" && this.behavior.obeyShutdown !== false) this.die(0, null);
    return true;
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === "SIGKILL" || !this.behavior.ignoreTerm) this.die(null, signal);
    return true;
  }
  die(code: number | null, signal: string | null) {
    if (this.exited) return;
    this.exited = true;
    setTimeout(() => this.emit("exit", code, signal), 1);
  }
  lastEmbed() {
    const embeds = this.sent.filter((m) => m.t === "embed");
    const last = embeds.at(-1);
    if (last?.t !== "embed") throw new Error("no embed sent");
    return last;
  }
  reply(vectors: number[][], token = this.lastEmbed().token, peakRssBytes: number | null = null) {
    this.emit("message", { t: "result", token, vectors, peakRssBytes });
  }
}

function manualClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  return {
    setTimeout(fn: () => void, ms: number) {
      timers.set(++id, { at: now + ms, fn, ms });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [key, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(key);
          timer.fn();
        }
    },
    pending: () => [...timers.values()].map((t) => t.ms),
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup(overrides: Partial<QwenSupervisorOptions> = {}, behavior?: FakeChild["behavior"]) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const clock = manualClock();
  const lease = {
    acquire: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
  const supervisor = createQwenSupervisor({
    childEntry: "/app/dist/qwen-child.mjs",
    guardPath: "/app/dist/child-guard",
    modelPath: "/models/Qwen3-Embedding-0.6B-Q8_0.gguf",
    clock,
    budgetBytes: () => 64 * 1024 ** 3,
    termGraceMs: 20,
    lease,
    pidAlive: (pid) => children.some((c) => c.pid === pid && !c.exited),
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new FakeChild(behavior);
      children.push(child);
      return child;
    },
    ...overrides,
  });
  const current = () => {
    const child = children.at(-1);
    if (!child) throw new Error("no child");
    return child;
  };
  return { supervisor, children, spawnCalls, clock, lease, current };
}

describe("qwen supervisor scheduling", () => {
  it("pins the scheduler constants", () => {
    expect(QWEN_IDLE_MS).toBe(15 * 60 * 1000);
    expect(QWEN_QUERY_BURST).toBe(4);
    expect(QWEN_MAX_WAITING).toEqual({ query: 4, document: 2 });
  });

  it("runs one execution at a time and admits one index batch after four consecutive queries", async () => {
    const { supervisor, current } = setup();
    const order: string[] = [];
    const run = (label: string, purpose: "query" | "document") =>
      supervisor.embed({ purpose, texts: [label], runtime: rt(1) }).then(() => order.push(label));
    const pending = [run("I0", "document")];
    await tick();
    for (const label of ["Q1", "Q2", "Q3", "Q4"]) pending.push(run(label, "query"));
    pending.push(run("I1", "document"));
    let extra = 5;
    for (let step = 0; step < 7; step++) {
      const child = current();
      const embed = child.lastEmbed();
      expect(child.sent.filter((m) => m.t === "embed")).toHaveLength(step + 1);
      child.reply([vec()]);
      await tick();
      // Keep the query queue non-empty so only the burst rule can admit I1.
      if (step < 4) pending.push(run(`Q${extra++}`, "query"));
      expect(embed.texts).toHaveLength(1);
    }
    expect(order).toEqual(["I0", "Q1", "Q2", "Q3", "Q4", "I1", "Q5"]);
    for (let i = 0; i < 3; i++) {
      current().reply([vec()]);
      await tick();
    }
    await Promise.all(pending);
  });

  it("an index backlog cannot delay a newly admitted query past the running batch", async () => {
    const { supervisor, current } = setup();
    const order: string[] = [];
    const run = (label: string, purpose: "query" | "document") =>
      supervisor.embed({ purpose, texts: [label], runtime: rt(1) }).then(() => order.push(label));
    const all = [run("I0", "document")];
    await tick();
    all.push(run("I1", "document"), run("I2", "document"), run("Q1", "query"));
    for (let i = 0; i < 4; i++) {
      current().reply([vec()]);
      await tick();
    }
    await Promise.all(all);
    expect(order).toEqual(["I0", "Q1", "I1", "I2"]);
  });

  it("bounds waiting work under the shared limits and rejects overflow immediately", async () => {
    const { supervisor, current } = setup();
    const running = supervisor.embed({ purpose: "document", texts: ["run"], runtime: rt(1) });
    await tick();
    const waiting = [
      ...Array.from({ length: 4 }, () =>
        supervisor.embed({ purpose: "query", texts: ["q"], runtime: rt(1) }),
      ),
      ...Array.from({ length: 2 }, () =>
        supervisor.embed({ purpose: "document", texts: ["d"], runtime: rt(1) }),
      ),
    ];
    await expect(
      supervisor.embed({ purpose: "query", texts: ["q5"], runtime: rt(1) }),
    ).rejects.toBeInstanceOf(QwenQueueFullError);
    await expect(
      supervisor.embed({ purpose: "document", texts: ["d3"], runtime: rt(1) }),
    ).rejects.toBeInstanceOf(QwenQueueFullError);
    expect(supervisor.snapshot().queued).toEqual({ query: 4, document: 2 });
    for (let i = 0; i < 7; i++) {
      current().reply([vec()]);
      await tick();
    }
    await Promise.all([running, ...waiting]);
  });

  it("an aborted waiting request leaves the queue without dispatch", async () => {
    const { supervisor, current } = setup();
    const running = supervisor.embed({ purpose: "document", texts: ["run"], runtime: rt(1) });
    await tick();
    const controller = new AbortController();
    const waiting = supervisor.embed({
      purpose: "query",
      texts: ["q"],
      runtime: rt(1),
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toBeTruthy();
    expect(supervisor.snapshot().queued.query).toBe(0);
    current().reply([vec()]);
    await running;
    await tick();
    expect(current().sent.filter((m) => m.t === "embed")).toHaveLength(1);
  });
});

describe("qwen supervisor child lifecycle", () => {
  it("spawns through the native guard with IPC and a minimal env (no secrets)", async () => {
    process.env.KB_QWEN_TEST_SECRET = "must-not-leak";
    try {
      const { supervisor, spawnCalls, current } = setup();
      const result = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(1) });
      await tick();
      current().reply([vec()]);
      await result;
      const call = spawnCalls[0]!;
      expect(call.command).toBe("/app/dist/child-guard");
      expect(call.args).toEqual([
        String(process.pid),
        process.execPath,
        "/app/dist/qwen-child.mjs",
        "qwen3-embedding-0.6b-q8_0",
      ]);
      const options = call.options as { stdio: unknown[]; env: Record<string, string> };
      expect(options.stdio).toContain("ipc");
      expect(options.env.KB_QWEN_CHILD).toBe("1");
      expect(options.env.KB_QWEN_MODEL_PATH).toBe("/models/Qwen3-Embedding-0.6B-Q8_0.gguf");
      // The admin runtime config travels through the minimal env.
      expect(options.env.KB_QWEN_CONTEXT_TOKENS).toBe("4096");
      expect(options.env.KB_QWEN_KV_KEY_TYPE).toBe("f16");
      expect(options.env.KB_QWEN_KV_VALUE_TYPE).toBe("f16");
      expect(JSON.stringify(options.env)).not.toContain("must-not-leak");
      expect(options.env).not.toHaveProperty("DATABASE_URL");
      expect(options.env).not.toHaveProperty("KB_MASTER_KEY");
    } finally {
      delete process.env.KB_QWEN_TEST_SECRET;
    }
  });

  it("validates vectors like external providers and returns them raw", async () => {
    const { supervisor, current } = setup();
    const good = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(1) });
    await tick();
    current().reply([vec(5)]);
    const [vector] = await good;
    expect(vector).toHaveLength(DIMS);
    // Raw, neither rounded nor normalized: the index format normalizes exactly once.
    expect(vector).toEqual(vec(5));

    for (const bad of [[vec().slice(1)], [vec(0)], [vec(Number.NaN)], [vec(), vec()]]) {
      const pending = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(1) });
      await tick();
      current().reply(bad);
      await expect(pending).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    }
  });

  it("maps a child overflow to EMBEDDING_INPUT_TOO_LONG without retrying", async () => {
    const { supervisor, current, children } = setup();
    const pending = supervisor.embed({ purpose: "document", texts: ["x"], runtime: rt(1) });
    await tick();
    current().emit("message", {
      t: "error",
      token: current().lastEmbed().token,
      code: "EMBEDDING_INPUT_TOO_LONG",
    });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingInputTooLongError);
    expect((error as EmbeddingInputTooLongError).code).toBe("EMBEDDING_INPUT_TOO_LONG");
    expect(children).toHaveLength(1);
    expect(current().sent.filter((m) => m.t === "embed")).toHaveLength(1);
  });

  it("idle 15m with no running or admitted work: child exits, PID awaited, lease released, next job reloads", async () => {
    const { supervisor, current, clock, lease, children } = setup();
    const first = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    expect(clock.pending()).toEqual([]); // no idle timer while work runs
    current().reply([vec()]);
    await first;
    await tick();
    expect(clock.pending()).toEqual([QWEN_IDLE_MS]);
    const firstPid = supervisor.snapshot().pid;
    expect(firstPid).toBe(children[0]?.pid);
    clock.advance(QWEN_IDLE_MS - 1);
    expect(children[0]?.sent.some((m) => m.t === "shutdown")).toBe(false);
    clock.advance(1);
    await tick(20);
    expect(children[0]?.sent.some((m) => m.t === "shutdown")).toBe(true);
    expect(children[0]?.exited).toBe(true);
    expect(supervisor.snapshot().pid).toBeNull();
    expect(lease.release).toHaveBeenCalledTimes(1);

    const second = supervisor.embed({ purpose: "query", texts: ["b"], runtime: rt(1) });
    await tick();
    expect(children).toHaveLength(2);
    expect(supervisor.snapshot().pid).toBe(children[1]?.pid);
    expect(children[1]?.pid).not.toBe(firstPid);
    current().reply([vec()]);
    await second;
  });

  it("admission during the idle window cancels the idle exit", async () => {
    const { supervisor, current, clock, children } = setup();
    const first = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    current().reply([vec()]);
    await first;
    await tick();
    clock.advance(QWEN_IDLE_MS - 10);
    const second = supervisor.embed({ purpose: "query", texts: ["b"], runtime: rt(1) });
    await tick();
    clock.advance(20);
    expect(children[0]?.sent.some((m) => m.t === "shutdown")).toBe(false);
    current().reply([vec()]);
    await second;
    expect(children).toHaveLength(1);
  });

  it("a TERM/shutdown-resistant idle child is SIGKILLed after the grace and reaped", async () => {
    const { supervisor, current, clock, children } = setup(
      {},
      { obeyShutdown: false, ignoreTerm: true },
    );
    const first = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    current().reply([vec()]);
    await first;
    await tick();
    clock.advance(QWEN_IDLE_MS);
    await tick(80);
    expect(children[0]?.signals).toContain("SIGKILL");
    expect(children[0]?.exited).toBe(true);
    expect(supervisor.snapshot().pid).toBeNull();
  });

  it("a crash retries the same fenced request once on a new child, then fails visibly", async () => {
    const { supervisor, current, children } = setup();
    const pending = supervisor.embed({ purpose: "document", texts: ["same"], runtime: rt(1) });
    await tick();
    const firstToken = current().lastEmbed().token;
    current().die(null, "SIGSEGV");
    await tick(10);
    expect(children).toHaveLength(2);
    const retry = current().lastEmbed();
    expect(retry.texts).toEqual(["same"]);
    expect(retry.token).not.toBe(firstToken);
    // A late reply carrying the dead attempt's token is discarded.
    current().emit("message", { t: "result", token: firstToken, vectors: [vec(9)] });
    current().reply([vec(2)]);
    const [vector] = await pending;
    expect(vector).toEqual(vec(2));

    const twice = supervisor.embed({ purpose: "document", texts: ["boom"], runtime: rt(1) });
    await tick();
    current().die(null, "SIGSEGV");
    await tick(10);
    current().die(null, "SIGSEGV");
    await expect(twice).rejects.toBeInstanceOf(QwenChildCrashedError);
    // child2 served the first request; child3 was the single retry.
    expect(children).toHaveLength(3);
  });

  it("stale replies from a replaced child never settle the current request", async () => {
    const { supervisor, current, children } = setup();
    const pending = supervisor.embed({ purpose: "document", texts: ["x"], runtime: rt(1) });
    await tick();
    const old = current();
    const oldToken = old.lastEmbed().token;
    old.exited = true; // exit reported, but a buffered reply still arrives afterwards
    old.emit("exit", null, "SIGKILL");
    await tick(10);
    old.emit("message", { t: "result", token: oldToken, vectors: [vec(7)] });
    expect(children).toHaveLength(2);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    current().reply([vec(4)]);
    await pending;
  });

  it("disable while running rejects running and queued work, SIGKILLs and awaits exit; late result ignored", async () => {
    const { supervisor, current, lease } = setup();
    const running = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(1) });
    running.catch(() => {});
    await tick();
    const queued = supervisor.embed({ purpose: "query", texts: ["b"], runtime: rt(1) });
    queued.catch(() => {});
    const child = current();
    const token = child.lastEmbed().token;
    const disabled = supervisor.disable();
    await disabled;
    expect(child.signals).toContain("SIGKILL");
    expect(child.exited).toBe(true);
    expect(supervisor.snapshot().pid).toBeNull();
    expect(lease.release).toHaveBeenCalled();
    await expect(running).rejects.toBeInstanceOf(QwenDisabledError);
    await expect(queued).rejects.toBeInstanceOf(QwenDisabledError);
    child.emit("message", { t: "result", token, vectors: [vec()] });
  });

  it("disable while loading kills the loading child and nothing is dispatched", async () => {
    const { supervisor, current } = setup({}, { autoReady: false });
    const pending = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(1) });
    pending.catch(() => {});
    await tick();
    const child = current();
    await supervisor.disable();
    await expect(pending).rejects.toBeInstanceOf(QwenDisabledError);
    expect(child.exited).toBe(true);
    expect(child.sent.filter((m) => m.t === "embed")).toHaveLength(0);
  });

  it("a new model epoch replaces the loaded child before dispatch", async () => {
    const { supervisor, current, children } = setup();
    const first = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    current().reply([vec()]);
    await first;
    const second = supervisor.embed({ purpose: "query", texts: ["b"], runtime: rt(2) });
    await tick(20);
    expect(children[0]?.exited).toBe(true);
    expect(children).toHaveLength(2);
    current().reply([vec()]);
    await second;
    expect(supervisor.loadedRuntime()).toEqual(rt(2));
  });

  it("a runtime config change (same epoch) replaces the loaded child and spawns it with the new config", async () => {
    const { supervisor, current, children, spawnCalls } = setup();
    const first = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    current().reply([vec()]);
    await first;
    const q8 = { contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q4_0" } as const;
    const second = supervisor.embed({ purpose: "query", texts: ["b"], runtime: rt(1, q8) });
    await tick(20);
    expect(children[0]?.exited).toBe(true);
    expect(children).toHaveLength(2);
    const env = (spawnCalls[1]!.options as { env: Record<string, string> }).env;
    expect(env).toMatchObject({
      KB_QWEN_CONTEXT_TOKENS: "8192",
      KB_QWEN_KV_KEY_TYPE: "q8_0",
      KB_QWEN_KV_VALUE_TYPE: "q4_0",
    });
    current().reply([vec()]);
    await second;
    expect(supervisor.loadedRuntime()).toEqual(rt(1, q8));
  });

  it("reports the child's peak RSS with the runtime it was measured under", async () => {
    const peaks: Array<[number, unknown]> = [];
    const { supervisor, current } = setup({
      onPeakRss: (bytes, runtime) => peaks.push([bytes, runtime]),
    });
    const first = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(5) });
    await tick();
    current().reply([vec()], undefined, 2_000_000_000);
    await first;
    const second = supervisor.embed({ purpose: "document", texts: ["b"], runtime: rt(5) });
    await tick();
    current().reply([vec()], undefined, null);
    await second;
    // VmHWM only grows: an unchanged peak is not re-reported, a higher one is.
    const third = supervisor.embed({ purpose: "document", texts: ["c"], runtime: rt(5) });
    await tick();
    current().reply([vec()], undefined, 2_000_000_000);
    await third;
    const fourth = supervisor.embed({ purpose: "document", texts: ["d"], runtime: rt(5) });
    await tick();
    current().reply([vec()], undefined, 2_100_000_000);
    await fourth;
    expect(peaks).toEqual([
      [2_000_000_000, rt(5)],
      [2_100_000_000, rt(5)],
    ]);
  });

  it("a busy model volume lease fails closed without spawning", async () => {
    const { supervisor, children, lease } = setup();
    lease.acquire.mockResolvedValueOnce(false);
    await expect(
      supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) }),
    ).rejects.toBeInstanceOf(QwenVolumeBusyError);
    expect(children).toHaveLength(0);
  });

  it("close() fences admission and reaps the child", async () => {
    const { supervisor, current } = setup();
    const first = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    current().reply([vec()]);
    await first;
    await supervisor.close();
    expect(current().exited).toBe(true);
    await expect(
      supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) }),
    ).rejects.toBeInstanceOf(QwenDisabledError);
  });
});

describe("createQwenEmbedder", () => {
  function fakeSupervisor(vectors: number[][]) {
    return {
      embed: vi.fn(async () => vectors),
    };
  }

  it("checks the absolute deadline after readiness even before the timer callback can run", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const supervisor = fakeSupervisor([vec()]);
    const beforeDispatch = vi.fn(async () => {});
    const embedder = createQwenEmbedder({
      supervisor,
      timeoutMs: 10,
      readReadyRuntime: async () => {
        now.mockReturnValue(120);
        return rt(1);
      },
    });
    try {
      await expect(
        embedder.embed(["x"], { purpose: "query", beforeDispatch }),
      ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
      expect(beforeDispatch).not.toHaveBeenCalled();
      expect(supervisor.embed).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("requires a READY model epoch before dispatch", async () => {
    const supervisor = fakeSupervisor([vec()]);
    const embedder = createQwenEmbedder({ supervisor, readReadyRuntime: async () => null });
    await expect(embedder.embed(["a"], { purpose: "query" })).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
    expect(supervisor.embed).not.toHaveBeenCalled();
  });

  it.each(["query", "document"] as const)(
    "disable/re-enable during a %s execution fences the late result",
    async (purpose) => {
      const supervisor = fakeSupervisor([vec()]);
      const epochs = [rt(3), rt(4)];
      const embedder = createQwenEmbedder({
        supervisor,
        readReadyRuntime: async () => epochs.shift() ?? null,
      });
      await expect(embedder.embed(["a"], { purpose })).rejects.toBeInstanceOf(
        EmbeddingUnavailableError,
      );
      expect(supervisor.embed).toHaveBeenCalledWith(expect.objectContaining({ runtime: rt(3) }));
    },
  );

  it.each(["query", "document"] as const)(
    "a runtime config change during a %s execution (same epoch) fences the late result",
    async (purpose) => {
      const supervisor = fakeSupervisor([vec()]);
      const reads = [rt(3), rt(3, { contextTokens: 8192, kvKeyType: "f16", kvValueType: "f16" })];
      const embedder = createQwenEmbedder({
        supervisor,
        readReadyRuntime: async () => reads.shift() ?? null,
      });
      await expect(embedder.embed(["a"], { purpose })).rejects.toBeInstanceOf(
        EmbeddingUnavailableError,
      );
    },
  );

  it("passes the pinned epoch, runs beforeDispatch, and returns vectors when the epoch holds", async () => {
    const supervisor = fakeSupervisor([vec()]);
    const beforeDispatch = vi.fn(async () => {});
    const embedder = createQwenEmbedder({ supervisor, readReadyRuntime: async () => rt(7) });
    const result = await embedder.embed(["hello"], { purpose: "query", beforeDispatch });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([vec()]);
    expect(supervisor.embed).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: rt(7), purpose: "query", texts: ["hello"] }),
    );
  });

  it("propagates EMBEDDING_INPUT_TOO_LONG and hides other failures", async () => {
    const tooLong = createQwenEmbedder({
      supervisor: { embed: async () => Promise.reject(new EmbeddingInputTooLongError()) },
      readReadyRuntime: async () => rt(1),
    });
    await expect(tooLong.embed(["a"], { purpose: "document" })).rejects.toBeInstanceOf(
      EmbeddingInputTooLongError,
    );
    const crashed = createQwenEmbedder({
      supervisor: { embed: async () => Promise.reject(new QwenChildCrashedError()) },
      readReadyRuntime: async () => rt(1),
    });
    await expect(crashed.embed(["a"], { purpose: "document" })).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
  });
});

describe("watchQwenModelRuntime", () => {
  it("joins an already running watch read and disable before shutdown returns", async () => {
    vi.useFakeTimers();
    const read = Promise.withResolvers<null>();
    const disabled = Promise.withResolvers<void>();
    const supervisor = {
      snapshot: () => ({ pid: 10 }),
      loadedRuntime: () => rt(2),
      disable: vi.fn(() => disabled.promise),
    };
    try {
      const stop = watchQwenModelRuntime(supervisor, () => read.promise, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      let stopped = false;
      const drain = stop().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      read.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(supervisor.disable).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
      disabled.resolve();
      await drain;
      await vi.advanceTimersByTimeAsync(5000);
      expect(stopped).toBe(true);
      expect(supervisor.disable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a live child as soon as the READY epoch or runtime config moves or disappears; idle parent never polls", async () => {
    vi.useFakeTimers();
    try {
      let pid: number | null = 10;
      const supervisor = {
        snapshot: () => ({ pid }),
        loadedRuntime: () => rt(2),
        disable: vi.fn(async () => {}),
      };
      const epochs: Array<ReturnType<typeof rt> | null> = [
        rt(2),
        rt(3),
        null,
        rt(2, { contextTokens: 32768, kvKeyType: "q8_0", kvValueType: "q8_0" }),
      ];
      const read = vi.fn(async () => epochs.shift() ?? null);
      const stop = watchQwenModelRuntime(supervisor, read, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.disable).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.disable).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.disable).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.disable).toHaveBeenCalledTimes(3);
      pid = null;
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledTimes(4);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

const CFG8K = { contextTokens: 8192, kvKeyType: "f16", kvValueType: "f16" } as const;

describe("config probe support in the supervisor", () => {
  function lastOf(child: FakeChild, t: "probe" | "count") {
    const found = child.sent.filter((m) => m.t === t).at(-1);
    if (!found || found.t !== t) throw new Error(`no ${t} sent`);
    return found;
  }

  it.each(["deadline", "timely result"] as const)(
    "keeps the default config-probe deadline at exactly two minutes: %s",
    async (outcome) => {
      vi.useFakeTimers();
      const { supervisor, children } = setup();
      try {
        let settled = false;
        const result = supervisor.probe(rt(1, CFG8K)).then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        await vi.advanceTimersByTimeAsync(0);
        const child = children[0]!;
        expect(lastOf(child, "probe")).toMatchObject({ t: "probe" });
        await vi.advanceTimersByTimeAsync(119_999);
        expect(settled).toBe(false);
        expect(child.exited).toBe(false);
        if (outcome === "timely result")
          child.emit("message", {
            t: "result",
            token: lastOf(child, "probe").token,
            vectors: [vec()],
            peakRssBytes: 2_500_000_000,
          });
        await vi.advanceTimersByTimeAsync(1);
        expect(child.exited).toBe(true);
        // FakeChild's actual exit event follows its signal by one clock tick.
        await vi.advanceTimersByTimeAsync(1);
        if (outcome === "deadline")
          expect(await result).toMatchObject({ code: "MODEL_CONFIG_PROBE_TIMEOUT" });
        else expect(await result).toEqual({ peakRssBytes: 2_500_000_000 });
        expect(settled).toBe(true);
        await supervisor.releaseLeaseHold();
      } finally {
        try {
          const closed = supervisor.close();
          await vi.advanceTimersByTimeAsync(1);
          await closed;
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it("side by side: a separate probe child loads the candidate config while the current child keeps serving", async () => {
    const { supervisor, children, spawnCalls, lease } = setup();
    const warm = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    children[0]!.reply([vec()]);
    await warm;
    expect(await supervisor.tryHoldLease()).toBe(true);
    // The live child already holds the volume lease: no second acquire.
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    const probe = supervisor.probe(rt(1, CFG8K), { timeoutMs: 5_000 });
    await tick();
    expect(children).toHaveLength(2);
    expect((spawnCalls[1]!.options as { env: Record<string, string> }).env).toMatchObject({
      KB_QWEN_CONTEXT_TOKENS: "8192",
    });
    // The current child still serves while the probe runs.
    const during = supervisor.embed({ purpose: "query", texts: ["b"], runtime: rt(1) });
    await tick();
    children[0]!.reply([vec()]);
    await expect(during).resolves.toHaveLength(1);
    const probeChild = children[1]!;
    probeChild.emit("message", {
      t: "result",
      token: lastOf(probeChild, "probe").token,
      vectors: [vec()],
      peakRssBytes: 2_500_000_000,
    });
    await expect(probe).resolves.toEqual({ peakRssBytes: 2_500_000_000 });
    // The probe child is always reaped; the serving child is untouched.
    expect(probeChild.exited).toBe(true);
    expect(children[0]!.exited).toBe(false);
    expect(supervisor.snapshot().pid).toBe(children[0]!.pid);
    await supervisor.releaseLeaseHold();
    expect(lease.release).not.toHaveBeenCalled(); // the serving child still holds it
  });

  it.each([
    ["the candidate config fails to load", "load"],
    ["the max-context embedding fails", "embed"],
    ["the probe exceeds its deadline", "timeout"],
  ] as const)("fails with a probe error when %s, and reaps the probe child", async (_, how) => {
    vi.useFakeTimers();
    const { supervisor, children } = setup({}, { autoReady: false });
    try {
      expect(await supervisor.tryHoldLease()).toBe(true);
      const result = supervisor.probe(rt(1, CFG8K), { timeoutMs: 50 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      const child = children[0]!;
      if (how === "load") child.emit("message", { t: "load_failed" });
      else {
        child.emit("message", { t: "ready" });
        await vi.advanceTimersByTimeAsync(0);
        if (how === "embed")
          child.emit("message", {
            t: "error",
            token: lastOf(child, "probe").token,
            code: "EMBED_FAILED",
          });
        else {
          await vi.advanceTimersByTimeAsync(49);
          expect(child.exited).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(child.exited).toBe(true);
        }
      }
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(QwenProbeError);
      expect((error as QwenProbeError).code).toBe(
        how === "timeout" ? "MODEL_CONFIG_PROBE_TIMEOUT" : "MODEL_CONFIG_PROBE_FAILED",
      );
      expect(child.exited).toBe(true);
      await supervisor.releaseLeaseHold();
    } finally {
      try {
        const closed = supervisor.close();
        await vi.advanceTimersByTimeAsync(1);
        await closed;
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("a probe result with wrong dimensions is a failed probe", async () => {
    const { supervisor, children } = setup();
    await supervisor.tryHoldLease();
    const probe = supervisor.probe(rt(1, CFG8K), { timeoutMs: 5_000 });
    await tick();
    const child = children[0]!;
    child.emit("message", {
      t: "result",
      token: lastOf(child, "probe").token,
      vectors: [[1, 2, 3]],
      peakRssBytes: null,
    });
    await expect(probe).rejects.toMatchObject({ code: "MODEL_CONFIG_PROBE_FAILED" });
    await supervisor.releaseLeaseHold();
  });

  it("stop-then-probe: suspend drains the running batch, stops the child, fails queries fast and parks documents until resume", async () => {
    const { supervisor, children } = setup();
    const running = supervisor.embed({ purpose: "document", texts: ["a"], runtime: rt(1) });
    await tick();
    let suspended = false;
    const suspending = supervisor.suspend().then(() => {
      suspended = true;
    });
    await tick();
    // The running batch is not killed mid-execution.
    expect(suspended).toBe(false);
    expect(children[0]!.exited).toBe(false);
    children[0]!.reply([vec()]);
    await expect(running).resolves.toHaveLength(1);
    await suspending;
    expect(children[0]!.exited).toBe(true);
    expect(supervisor.snapshot().pid).toBeNull();
    // Gap: queries fail fast (search degrades to lexical), documents wait.
    await expect(
      supervisor.embed({ purpose: "query", texts: ["q"], runtime: rt(1) }),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    const parked = supervisor.embed({ purpose: "document", texts: ["d"], runtime: rt(1) });
    await tick(20);
    expect(children).toHaveLength(1);
    supervisor.resume();
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.reply([vec()]);
    await expect(parked).resolves.toHaveLength(1);
  });

  it("the volume lease is acquired once and released only after the last holder (probe hold and child) lets go", async () => {
    const { supervisor, children, lease, clock } = setup();
    expect(await supervisor.tryHoldLease()).toBe(true);
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    const q = supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    await tick();
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    children[0]!.reply([vec()]);
    await q;
    await tick();
    clock.advance(QWEN_IDLE_MS);
    await tick(30);
    expect(children[0]!.exited).toBe(true);
    expect(lease.release).not.toHaveBeenCalled();
    await supervisor.releaseLeaseHold();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("tryHoldLease reports a lease held by another worker", async () => {
    const { supervisor, lease } = setup();
    lease.acquire.mockResolvedValueOnce(false);
    expect(await supervisor.tryHoldLease()).toBe(false);
    expect(lease.release).not.toHaveBeenCalled();
  });

  it("countTokens asks the child of that runtime and returns counts with its limit", async () => {
    const { supervisor, children } = setup();
    const counting = supervisor.countTokens({
      purpose: "document",
      texts: ["ab", "cde"],
      runtime: rt(1, CFG8K),
    });
    await tick();
    const child = children[0]!;
    child.emit("message", {
      t: "counts",
      token: lastOf(child, "count").token,
      counts: [3, 4],
      limit: 8192,
    });
    await expect(counting).resolves.toEqual({ counts: [3, 4], limit: 8192 });
  });
});

describe("createQwenEmbedder input measurement", () => {
  it("measures document inputs under the READY runtime and fences a config change", async () => {
    const supervisor = {
      embed: vi.fn(async () => [vec()]),
      countTokens: vi.fn(async () => ({ counts: [5], limit: 1024 })),
    };
    const stable = createQwenEmbedder({ supervisor, readReadyRuntime: async () => rt(2) });
    await expect(stable.measureInputs?.(["hello"], {})).resolves.toEqual({
      counts: [5],
      limit: 1024,
    });
    expect(supervisor.countTokens).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "document", texts: ["hello"], runtime: rt(2) }),
    );
    const reads = [rt(2), rt(2, CFG8K)];
    const moved = createQwenEmbedder({
      supervisor,
      readReadyRuntime: async () => reads.shift() ?? null,
    });
    await expect(moved.measureInputs?.(["hello"], {})).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
  });
});

it("46r10 dynamic Gemma selection uses its registry artifact and rejects Qwen dimensions before accepting 768-d vectors", async () => {
  const { supervisor, current, spawnCalls } = setup({ modelsDir: "/fixture/models" });
  const runtime = { ...rt(1), modelId: "embeddinggemma-2-q8_0" };
  const wrong = supervisor.embed({ purpose: "query", texts: ["hello"], runtime });
  const rejected = expect(wrong).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  await tick();
  expect(spawnCalls[0]?.args).toContain(runtime.modelId);
  expect(spawnCalls[0]?.options).toMatchObject({
    env: { KB_QWEN_MODEL_PATH: "/fixture/models/embeddinggemma-2-Q8_0.gguf" },
  });
  current().reply([vec()]);
  await rejected;
  const valid = supervisor.embed({ purpose: "query", texts: ["hello"], runtime });
  await tick();
  current().reply([Array.from({ length: 768 }, (_, i) => (i === 0 ? 5 : 0))]);
  expect((await valid)[0]).toHaveLength(768);
  await supervisor.close();
});

it.each(["deadline", "timely result"] as const)(
  "keeps the default serving deadline at exactly two minutes: %s",
  async (outcome) => {
    vi.useFakeTimers();
    const { supervisor, children } = setup();
    try {
      let settled = false;
      const result = supervisor
        .embed({ purpose: "document", texts: ["boundary"], runtime: rt(1) })
        .then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await vi.advanceTimersByTimeAsync(0);
      const child = children[0]!;
      expect(child.lastEmbed()).toMatchObject({ t: "embed" });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      expect(child.exited).toBe(false);
      if (outcome === "timely result") {
        child.reply([vec()]);
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual([vec()]);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(child.exited).toBe(outcome === "deadline");
      // The timeout joins the child's exit before rejecting the caller.
      await vi.advanceTimersByTimeAsync(1);
      if (outcome === "deadline") expect(await result).toBeInstanceOf(EmbeddingUnavailableError);
      expect(settled).toBe(true);
      expect(children).toHaveLength(1);
    } finally {
      try {
        const closed = supervisor.close();
        await vi.advanceTimersByTimeAsync(1);
        await closed;
      } finally {
        vi.useRealTimers();
      }
    }
  },
);

it("R45 keeps one admission deadline through queue wait and the crash retry", async () => {
  vi.useFakeTimers();
  const { supervisor, children } = setup({ servingTimeoutMs: 1000 });
  try {
    const pending = supervisor.embed({ purpose: "document", texts: ["retry"], runtime: rt(1) });
    const rejected = expect(pending).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await vi.advanceTimersByTimeAsync(500);
    children[0]!.die(null, "SIGSEGV");
    await vi.advanceTimersByTimeAsync(10);
    expect(children).toHaveLength(2);
    let settled = false;
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(489);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(children[1]!.exited).toBe(true);
    expect(children).toHaveLength(2);
  } finally {
    await supervisor.close();
    vi.useRealTimers();
  }
});

it("R45 a suspended document's default deadline removes it without a late dispatch on resume", async () => {
  const { supervisor, children } = setup({ servingTimeoutMs: 20 });
  await supervisor.suspend();
  const parked = supervisor.embed({ purpose: "document", texts: ["parked"], runtime: rt(1) });
  await expect(parked).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  supervisor.resume();
  expect(supervisor.snapshot().queued.document).toBe(0);
  expect(children).toHaveLength(0);
  const healthy = supervisor.embed({ purpose: "query", texts: ["healthy"], runtime: rt(1) });
  await tick();
  children[0]!.reply([vec()]);
  await expect(healthy).resolves.toHaveLength(1);
  await supervisor.close();
});

it("R45 renewal expiry kills the child before SQL drain, but close and release join that drain", async () => {
  vi.useFakeTimers();
  const renewed = Promise.withResolvers<boolean>();
  let renewalSignal: AbortSignal | undefined;
  const lease = {
    acquire: vi.fn(async () => true),
    renew: vi.fn((signal?: AbortSignal) => {
      renewalSignal = signal;
      return renewed.promise;
    }),
    release: vi.fn(async () => {}),
  };
  const { supervisor, children } = setup({
    lease,
    leaseRenewMs: 5,
    leaseRenewTimeoutMs: 25,
  });
  try {
    const first = supervisor.embed({ purpose: "query", texts: ["first"], runtime: rt(1) });
    await vi.advanceTimersByTimeAsync(1);
    children[0]!.reply([vec()]);
    await first;
    await vi.advanceTimersByTimeAsync(30);
    expect(lease.renew).toHaveBeenCalledTimes(1);
    expect(renewalSignal?.aborted).toBe(true);
    expect(children[0]!.signals).toContain("SIGKILL");
    expect(children[0]!.exited).toBe(true);
    expect(lease.release).not.toHaveBeenCalled();
    let closed = false;
    const close = supervisor.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(closed).toBe(false);
    expect(lease.renew).toHaveBeenCalledTimes(1);
    expect(lease.release).not.toHaveBeenCalled();
    renewed.resolve(false);
    await close;
    expect(lease.release).toHaveBeenCalledTimes(1);
  } finally {
    renewed.resolve(false);
    try {
      const close = supervisor.close();
      await vi.advanceTimersByTimeAsync(30);
      await close;
    } finally {
      vi.useRealTimers();
    }
  }
});

it("R45 normal last-holder release joins an in-flight heartbeat without cancelling its successor", async () => {
  const renewed = Promise.withResolvers<boolean>();
  const lease = {
    acquire: vi.fn(async () => true),
    renew: vi.fn(() => renewed.promise),
    release: vi.fn(async () => {}),
  };
  const { supervisor, children, clock } = setup({ lease, leaseRenewMs: 5 });
  const first = supervisor.embed({ purpose: "query", texts: ["first"], runtime: rt(1) });
  await tick();
  children[0]!.reply([vec()]);
  await first;
  await vi.waitFor(() => expect(lease.renew).toHaveBeenCalledTimes(1));
  clock.advance(QWEN_IDLE_MS);
  const next = supervisor.embed({ purpose: "query", texts: ["successor"], runtime: rt(1) });
  await tick(20);
  expect(children[0]!.exited).toBe(true);
  expect(children).toHaveLength(1);
  expect(lease.release).not.toHaveBeenCalled();
  renewed.resolve(true);
  await tick(20);
  expect(children).toHaveLength(2);
  children[1]!.reply([vec()]);
  await expect(next).resolves.toHaveLength(1);
  expect(lease.release).toHaveBeenCalledTimes(1);
  await supervisor.close();
  expect(lease.release).toHaveBeenCalledTimes(2);
});

// Closed classification through the real supervisor -> adapter path: only the child's own
// embed reply produces the degradable `EmbedderCallError`; model-volume lease acquisition and
// renewal (SQL-backed) failures stay untagged and never become "the embedder failed".
describe("degradable classification through the real supervisor and adapter", () => {
  const adapter = (supervisor: ReturnType<typeof setup>["supervisor"]) =>
    createQwenEmbedder({ supervisor, readReadyRuntime: async () => rt(1) });

  it("a lease-acquisition SQL failure is untagged and spawns no child", async () => {
    const lease = {
      acquire: vi.fn(async () => {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }),
      renew: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    };
    const { supervisor, children } = setup({ lease });
    const error = await adapter(supervisor)
      .embed(["q"], { purpose: "query" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingUnavailableError);
    expect(error).not.toBeInstanceOf(EmbedderCallError);
    expect(children).toHaveLength(0);
    await supervisor.close();
  });

  it("a lease-renewal SQL failure mid-request is untagged", async () => {
    const lease = {
      acquire: vi.fn(async () => true),
      renew: vi.fn(async () => {
        throw Object.assign(new Error("connection terminated"), { code: "57P01" });
      }),
      release: vi.fn(async () => {}),
    };
    const { supervisor, children } = setup({ lease, leaseRenewMs: 5 });
    const pending = adapter(supervisor)
      .embed(["q"], { purpose: "query" })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(lease.renew).toHaveBeenCalled());
    const error = await pending;
    expect(children).toHaveLength(1);
    expect(error).toBeInstanceOf(EmbeddingUnavailableError);
    expect(error).not.toBeInstanceOf(EmbedderCallError);
    await supervisor.close();
  });

  it("the child's own error reply or invalid vectors are the degradable tag", async () => {
    const { supervisor, current } = setup();
    const embedder = adapter(supervisor);
    const failed = embedder.embed(["q"], { purpose: "query" }).catch((e: unknown) => e);
    await tick();
    current().emit("message", {
      t: "error",
      token: current().lastEmbed().token,
      code: "MODEL_ERROR",
    });
    expect(await failed).toBeInstanceOf(EmbedderCallError);
    const invalid = embedder.embed(["q"], { purpose: "query" }).catch((e: unknown) => e);
    await tick();
    current().reply([[Number.NaN]]);
    expect(await invalid).toBeInstanceOf(EmbedderCallError);
    await supervisor.close();
  });
});
