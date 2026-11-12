import { EventEmitter } from "node:events";
import { QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import { ModelArtifactError } from "@knowledge-base/api/lib/kb/model-artifact";
import { describe, expect, it, vi } from "vitest";
import type { ParentToChild } from "./qwen-child";
import type { QwenChildHandle } from "./qwen-lifecycle";
import { probeQwenRuntime } from "./qwen-probe";

type Mode = "ok" | "load_failed" | "wrong_dims" | "nan" | "silent" | "max_fail";

/** In-memory child that speaks the real IPC protocol; exits on kill/shutdown. */
type Seen = {
  spawned: number;
  killed: number;
  embeds: string[];
  texts: string[];
  env: Record<string, string>[];
};
function fakeSpawn(mode: Mode, seen: Seen) {
  return (_command: string, _args: string[], options: { env: Record<string, string> }) => {
    seen.env.push(options.env);
    seen.spawned += 1;
    const emitter = new EventEmitter();
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      queueMicrotask(() => emitter.emit("exit", 0, null));
    };
    const handle = {
      pid: 4242,
      send(message: ParentToChild) {
        if (message.t === "shutdown") exit();
        if (message.t === "probe") {
          if (mode === "max_fail")
            queueMicrotask(() =>
              emitter.emit("message", {
                t: "error",
                token: message.token,
                code: "EMBEDDING_FAILED",
              }),
            );
          else
            queueMicrotask(() =>
              emitter.emit("message", {
                t: "result",
                token: message.token,
                vectors: [Array.from({ length: 1024 }, (_, j) => j % 7)],
                peakRssBytes: 1_900_000_003,
              }),
            );
        }
        if (message.t === "embed") {
          seen.embeds.push(message.purpose);
          seen.texts.push(...message.texts);
          const dims = mode === "wrong_dims" ? 8 : 1024;
          const vectors = message.texts.map((_, i) =>
            Array.from({ length: dims }, (_, j) => (mode === "nan" ? Number.NaN : (i + j) % 7)),
          );
          queueMicrotask(() =>
            emitter.emit("message", {
              t: "result",
              token: message.token,
              vectors,
              peakRssBytes: 1_900_000_000 + seen.embeds.length,
            }),
          );
        }
        return true;
      },
      kill() {
        seen.killed += 1;
        exit();
        return true;
      },
      on: (event: "message", listener: (m: unknown) => void) => emitter.on(event, listener),
      once: (event: string, listener: (...args: unknown[]) => void) =>
        emitter.once(event, listener),
    };
    if (mode === "load_failed") queueMicrotask(() => emitter.emit("message", { t: "load_failed" }));
    else if (mode !== "silent") queueMicrotask(() => emitter.emit("message", { t: "ready" }));
    return handle as unknown as QwenChildHandle;
  };
}

const CONFIG = { contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q8_0" } as const;

function probe(mode: Mode, timeoutMs = 2_000) {
  const seen: Seen = { spawned: 0, killed: 0, embeds: [], texts: [], env: [] };
  const run = probeQwenRuntime({
    modelId: QWEN_MODEL.modelId,
    config: CONFIG,
    budgetBytes: () => 8 * 1024 ** 3,
    childEntry: "/fixture/qwen-child.mjs",
    modelPath: "/fixture/model.gguf",
    guardPath: "/fixture/guard",
    timeoutMs,
    spawn: fakeSpawn(mode, seen),
    pidAlive: () => false,
  });
  return { run, seen };
}

describe("Qwen runtime capability probe (READY gate)", () => {
  it("passes only after the real child protocol embeds a query and a document at 1024 dims, then reaps the child", async () => {
    const { run, seen } = probe("ok");
    // The probe reports the child's real peak RSS (VmHWM) under the configured runtime.
    await expect(run).resolves.toEqual({ dimensions: 1024, peakRssBytes: 1_900_000_003 });
    expect(seen.embeds).toEqual(["query", "document"]);
    expect(seen.env[0]).toMatchObject({
      KB_QWEN_CONTEXT_TOKENS: "8192",
      KB_QWEN_KV_KEY_TYPE: "q8_0",
      KB_QWEN_KV_VALUE_TYPE: "q8_0",
    });
    // The document spans more than one 512-token decode batch, so the recorded
    // peak includes the full per-batch buffers (whitespace words >= tokens here).
    expect(seen.texts[1]!.split(/\s+/).length).toBeGreaterThan(512);
    expect(seen.spawned).toBe(2);
    // The probe child never outlives the probe.
    expect(seen.killed).toBe(2);
  });

  it.each([["load_failed"], ["wrong_dims"], ["nan"], ["max_fail"]] as const)(
    "%s fails with MODEL_RUNTIME_UNSUPPORTED (no activation)",
    async (mode) => {
      const { run, seen } = probe(mode);
      const error = await run.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelArtifactError);
      expect(error).toMatchObject({
        code: "MODEL_RUNTIME_UNSUPPORTED",
        retryable: false,
        cause: expect.any(Error),
      });
      expect(seen.spawned).toBeGreaterThanOrEqual(1);
    },
  );

  it("a child that never becomes ready is bounded by the probe deadline and killed", async () => {
    const { run, seen } = probe("silent", 50);
    await expect(run).rejects.toMatchObject({
      code: "MODEL_RUNTIME_UNSUPPORTED",
      cause: { message: "Model runtime probe deadline exceeded." },
    });
    expect(seen.killed).toBeGreaterThanOrEqual(1);
  });

  it("the default READY deadline stays 120 seconds and reaps an unready child", async () => {
    vi.useFakeTimers();
    try {
      const seen: Seen = { spawned: 0, killed: 0, embeds: [], texts: [], env: [] };
      let settled = false;
      const run = probeQwenRuntime({
        modelId: QWEN_MODEL.modelId,
        config: CONFIG,
        budgetBytes: () => 8 * 1024 ** 3,
        childEntry: "/fixture/qwen-child.mjs",
        modelPath: "/fixture/model.gguf",
        guardPath: "/fixture/guard",
        spawn: fakeSpawn("silent", seen),
        pidAlive: () => false,
      });
      const rejected = expect(run).rejects.toMatchObject({ code: "MODEL_RUNTIME_UNSUPPORTED" });
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      expect(seen.killed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(settled).toBe(true);
      expect(seen.killed).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a missing guard/child (spawn failure, e.g. dev outside the image) fails closed", async () => {
    const run = probeQwenRuntime({
      modelId: QWEN_MODEL.modelId,
      config: CONFIG,
      childEntry: "/fixture/qwen-child.mjs",
      modelPath: "/fixture/model.gguf",
      guardPath: "/nonexistent/kb-child-guard",
      timeoutMs: 2_000,
    });
    await expect(run).rejects.toMatchObject({ code: "MODEL_RUNTIME_UNSUPPORTED" });
  });
});
