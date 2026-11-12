import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { GEMMA_MODEL, QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import { QWEN_ARTIFACT } from "@knowledge-base/api/lib/kb/model-artifact";
import {
  DEFAULT_QWEN_RUNTIME_CONFIG,
  QWEN_CONTEXT_OPTIONS,
  QWEN_KV_TYPES,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { describe, expect, it, vi } from "vitest";
import {
  assertBuiltinBatch,
  builtinNativeOptions,
  type ChildToParent,
  type ParentToChild,
  parseQwenChildConfig,
  prepareBuiltinTokens,
  type QwenBackend,
  QwenInputTooLongError,
  qwenNativeOptions,
  readVmHwmBytes,
  runQwenChild,
} from "./qwen-child";

const EOS = 151643;
const PREFIX =
  "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

/** Deterministic fake tokenizer: one token per character code (no BOS, no EOS). */
const charTokens = (text: string) => Array.from(text, (ch) => (ch.codePointAt(0) ?? 0) % 100_000);

describe("prepareBuiltinTokens with Qwen", () => {
  it("binds the exact prefix (actual newline) and registry constants", () => {
    expect(QWEN_ARTIFACT.queryPrefix).toBe(PREFIX);
    expect(PREFIX).toContain("query\nQuery: ");
    expect(QWEN_ARTIFACT.eosTokenId).toBe(EOS);
    expect(DEFAULT_QWEN_RUNTIME_CONFIG.contextTokens).toBe(4096);
    expect(QWEN_ARTIFACT.addBos).toBe(false);
    expect(QWEN_ARTIFACT.addEos).toBe(true);
  });

  it("prefixes queries, keeps documents raw, never adds BOS and appends EOS exactly once", () => {
    const seen: string[] = [];
    const tokenize = (text: string) => {
      seen.push(text);
      return charTokens(text);
    };
    const doc = prepareBuiltinTokens(QWEN_MODEL, "hello", "document", tokenize, 4096);
    const query = prepareBuiltinTokens(QWEN_MODEL, "hello", "query", tokenize, 4096);
    expect(seen).toEqual(["hello", `${PREFIX}hello`]);
    expect(doc).toEqual([...charTokens("hello"), EOS]);
    expect(query).toEqual([...charTokens(`${PREFIX}hello`), EOS]);
    for (const tokens of [doc, query]) expect(tokens.filter((t) => t === EOS)).toHaveLength(1);
    expect(doc[0]).not.toBe(EOS); // BOS and EOS share an id; neither is prepended
  });

  it("rejects a tokenizer that emits the special EOS/BOS id instead of doubling it", () => {
    expect(() => prepareBuiltinTokens(QWEN_MODEL, "x", "document", () => [1, EOS], 4096)).toThrow();
    expect(() => prepareBuiltinTokens(QWEN_MODEL, "x", "document", () => [EOS, 1], 4096)).toThrow();
  });

  it("allows exactly 4096 tokens including prefix and EOS; 4097 is EMBEDDING_INPUT_TOO_LONG", () => {
    const fits = prepareBuiltinTokens(
      QWEN_MODEL,
      "x",
      "document",
      () => new Array(4095).fill(7),
      4096,
    );
    expect(fits).toHaveLength(4096);
    let error: unknown;
    try {
      prepareBuiltinTokens(QWEN_MODEL, "x", "document", () => new Array(4096).fill(7), 4096);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QwenInputTooLongError);
    expect((error as QwenInputTooLongError).code).toBe("EMBEDDING_INPUT_TOO_LONG");
    // The query prefix counts against the same budget.
    const prefixLen = charTokens(PREFIX).length;
    expect(() =>
      prepareBuiltinTokens(
        QWEN_MODEL,
        "q",
        "query",
        (text) =>
          text.startsWith(PREFIX)
            ? new Array(4096 - prefixLen).fill(3).concat(charTokens(PREFIX))
            : [],
        4096,
      ),
    ).toThrow(QwenInputTooLongError);
  });

  it("<=400 words that tokenize to >4096 subwords are rejected (word count never implies fit)", () => {
    const words = Array.from({ length: 400 }, (_, i) => `pathological${i}`);
    const text = words.join(" ");
    expect(text.split(" ")).toHaveLength(400);
    // Subword fixture: every word explodes into 11 subword tokens -> 4400 tokens.
    const subword = (input: string) => input.split(" ").flatMap(() => new Array(11).fill(42));
    expect(() => prepareBuiltinTokens(QWEN_MODEL, text, "document", subword, 4096)).toThrow(
      QwenInputTooLongError,
    );
  });
});

function harness(
  backend: Partial<QwenBackend> & { embed?: QwenBackend["embed"] },
  contextTokens = 4096,
) {
  const sent: ChildToParent[] = [];
  let onMessage: (message: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  const exit = vi.fn();
  const full: QwenBackend = {
    tokenize: backend.tokenize ?? charTokens,
    embed: backend.embed ?? (async (tokens) => [tokens.length, 1]),
    dispose: backend.dispose ?? (async () => {}),
  };
  const load = vi.fn(async () => full);
  const running = runQwenChild(
    {
      send: (message) => sent.push(message),
      onMessage: (listener) => {
        onMessage = listener;
      },
      onDisconnect: (listener) => {
        onDisconnect = listener;
      },
      exit,
    },
    load,
    { contextTokens, readPeakRssBytes: () => 1_500_000_000 },
  );
  return {
    sent,
    exit,
    load,
    running,
    deliver: (message: ParentToChild | unknown) => onMessage(message),
    disconnect: () => onDisconnect(),
    backend: full,
  };
}

const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

describe("configured context and native options", () => {
  it("the input limit follows the configured contextTokens (prefix and EOS included)", () => {
    for (const contextTokens of QWEN_CONTEXT_OPTIONS) {
      expect(
        prepareBuiltinTokens(
          QWEN_MODEL,
          "x",
          "document",
          () => new Array(contextTokens - 1).fill(7),
          contextTokens,
        ),
      ).toHaveLength(contextTokens);
      expect(() =>
        prepareBuiltinTokens(
          QWEN_MODEL,
          "x",
          "document",
          () => new Array(contextTokens).fill(7),
          contextTokens,
        ),
      ).toThrow(QwenInputTooLongError);
    }
  });

  it("decodes in 512-token batches regardless of context, flash attention on, KV types mapped", () => {
    const ggml: Record<string, string> = { f16: "F16", q8_0: "Q8_0", q4_0: "Q4_0" };
    for (const contextTokens of QWEN_CONTEXT_OPTIONS)
      for (const kvKeyType of QWEN_KV_TYPES)
        for (const kvValueType of QWEN_KV_TYPES) {
          const options = qwenNativeOptions({ contextTokens, kvKeyType, kvValueType }, 2);
          expect(options).toEqual({
            model: {
              useMmap: true,
              defaultContextFlashAttention: true,
              experimentalDefaultContextKvCacheKeyType: ggml[kvKeyType],
              experimentalDefaultContextKvCacheValueType: ggml[kvValueType],
            },
            // One slot of headroom: the addon rejects input.length >= contextSize.
            context: { contextSize: contextTokens + 1, batchSize: 512, threads: 2 },
          });
        }
  });

  it("fits the CPU allocation without starving a one-core runtime or raising the old six-thread cap", () => {
    const config = { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" } as const;
    for (const [available, expected] of [
      [1, 1],
      [2, 2],
      [4, 4],
      [8, 6],
    ]) {
      expect(qwenNativeOptions(config, available).context.threads).toBe(expected);
    }
  });

  it("parses the child config from its env and refuses anything else", () => {
    expect(
      parseQwenChildConfig({
        KB_QWEN_CONTEXT_TOKENS: "8192",
        KB_QWEN_KV_KEY_TYPE: "q8_0",
        KB_QWEN_KV_VALUE_TYPE: "q4_0",
      }),
    ).toEqual({ contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q4_0" });
    for (const env of [
      {},
      { KB_QWEN_CONTEXT_TOKENS: "4096", KB_QWEN_KV_KEY_TYPE: "f16" },
      { KB_QWEN_CONTEXT_TOKENS: "4097", KB_QWEN_KV_KEY_TYPE: "f16", KB_QWEN_KV_VALUE_TYPE: "f16" },
      { KB_QWEN_CONTEXT_TOKENS: "4096", KB_QWEN_KV_KEY_TYPE: "f32", KB_QWEN_KV_VALUE_TYPE: "f16" },
      { KB_QWEN_CONTEXT_TOKENS: "4096x", KB_QWEN_KV_KEY_TYPE: "f16", KB_QWEN_KV_VALUE_TYPE: "f16" },
    ])
      expect(parseQwenChildConfig(env)).toBeNull();
  });

  it("reads VmHWM (peak RSS) from /proc status text in bytes", () => {
    expect(
      readVmHwmBytes("Name:\tnode\nVmPeak:\t 999 kB\nVmHWM:\t  2048 kB\nVmRSS:\t 10 kB\n"),
    ).toBe(2048 * 1024);
    expect(readVmHwmBytes("Name:\tnode\n")).toBeNull();
  });
});

describe("runQwenChild", () => {
  it("loads once, announces ready, and answers embed with the request token", async () => {
    const embed = vi.fn(async (tokens: readonly number[]) => [tokens.length, 0]);
    const h = harness({ embed });
    await h.running;
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([{ t: "ready" }]);
    h.deliver({ t: "embed", token: "tok-1", purpose: "document", texts: ["ab", "c"] });
    await flush();
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[0]?.[0]).toEqual([...charTokens("ab"), EOS]);
    // Every result reports the child's peak RSS so the parent can record it.
    expect(h.sent[1]).toEqual({
      t: "result",
      token: "tok-1",
      vectors: [
        [3, 0],
        [2, 0],
      ],
      peakRssBytes: 1_500_000_000,
    });
  });

  it("tokenizes the whole batch before any native execute; overflow executes nothing", async () => {
    const embed = vi.fn(async () => [1]);
    const h = harness({
      embed,
      tokenize: (text) => (text === "long" ? new Array(5000).fill(9) : [1]),
    });
    await h.running;
    h.deliver({ t: "embed", token: "tok-2", purpose: "document", texts: ["short", "long"] });
    await flush();
    expect(embed).not.toHaveBeenCalled();
    expect(h.sent[1]).toEqual({ t: "error", token: "tok-2", code: "EMBEDDING_INPUT_TOO_LONG" });
  });

  it("maps native failures to a fixed code and ignores malformed messages", async () => {
    const h = harness({
      embed: async () => {
        throw new Error("secret native detail");
      },
    });
    await h.running;
    h.deliver({ t: "embed", token: 5, texts: "nope" });
    h.deliver("garbage");
    h.deliver({ t: "embed", token: "tok-3", purpose: "query", texts: ["q"] });
    await flush();
    expect(h.sent.slice(1)).toEqual([{ t: "error", token: "tok-3", code: "EMBED_FAILED" }]);
    expect(JSON.stringify(h.sent)).not.toContain("secret native detail");
  });

  it("shutdown disposes the model and exits 0; parent disconnect exits without waiting", async () => {
    const dispose = vi.fn(async () => {});
    const h = harness({ dispose });
    await h.running;
    h.deliver({ t: "shutdown" });
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);

    const orphan = harness({});
    await orphan.running;
    orphan.disconnect();
    expect(orphan.exit).toHaveBeenCalledWith(1);
  });

  it("a load failure reports load_failed and exits non-zero", async () => {
    const sent: ChildToParent[] = [];
    const exit = vi.fn();
    await runQwenChild(
      { send: (m) => sent.push(m), onMessage: () => {}, onDisconnect: () => {}, exit },
      async () => {
        throw new Error("bad gguf");
      },
      { contextTokens: 4096, readPeakRssBytes: () => null },
    );
    expect(sent).toEqual([{ t: "load_failed" }]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("token counts and the max-context load probe", () => {
  it("counts each input as the model would feed it (query prefix + EOS), never rejecting, with the limit", async () => {
    const embed = vi.fn(async () => [1]);
    const h = harness({ embed }, 1024);
    await h.running;
    const long = "x".repeat(5000);
    h.deliver({ t: "count", token: "c-1", purpose: "document", texts: ["ab", long] });
    h.deliver({ t: "count", token: "c-2", purpose: "query", texts: ["ab"] });
    await flush();
    expect(embed).not.toHaveBeenCalled();
    expect(h.sent.slice(1)).toEqual([
      { t: "counts", token: "c-1", counts: [3, 5001], limit: 1024 },
      { t: "counts", token: "c-2", counts: [PREFIX.length + 3], limit: 1024 },
    ]);
  });

  it("a malformed count request is ignored; a tokenizer failure is a fixed error code", async () => {
    const h = harness({
      tokenize: () => {
        throw new Error("tokenizer detail");
      },
    });
    await h.running;
    h.deliver({ t: "count", token: "c-3", purpose: "document", texts: "nope" });
    h.deliver({ t: "count", token: "c-4", purpose: "document", texts: ["a"] });
    await flush();
    expect(h.sent.slice(1)).toEqual([{ t: "error", token: "c-4", code: "EMBED_FAILED" }]);
  });

  it.each([1024, 4096])(
    "probe embeds exactly one max-context input (%i tokens incl. EOS) and reports the peak",
    async (contextTokens) => {
      const embed = vi.fn(async (tokens: readonly number[]) => [tokens.length, 0]);
      const h = harness({ embed }, contextTokens);
      await h.running;
      h.deliver({ t: "probe", token: "p-1" });
      await flush();
      expect(embed).toHaveBeenCalledTimes(1);
      const tokens = embed.mock.calls[0]![0];
      expect(tokens).toHaveLength(contextTokens);
      expect(tokens.at(-1)).toBe(EOS);
      expect(tokens.slice(0, -1)).not.toContain(EOS);
      expect(h.sent[1]).toEqual({
        t: "result",
        token: "p-1",
        vectors: [[contextTokens, 0]],
        peakRssBytes: 1_500_000_000,
      });
    },
  );

  it("a probe whose native execute fails reports EMBED_FAILED", async () => {
    const h = harness({
      embed: async () => {
        throw new Error("ggml alloc failed");
      },
    });
    await h.running;
    h.deliver({ t: "probe", token: "p-2" });
    await flush();
    expect(h.sent[1]).toEqual({ t: "error", token: "p-2", code: "EMBED_FAILED" });
  });
});

describe("addon confinement", () => {
  // Scan immutable source inputs during collection, before the timed assertions.
  const root = resolve(import.meta.dirname, "../../../..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "generated", ".turbo"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        // A module specifier (import/require/dynamic import), not a version label.
        if (/["'`]node-llama-cpp(\/[^"'`]*)?["'`]/.test(readFileSync(path, "utf8")))
          offenders.push(relative(root, path));
      }
    }
  };
  for (const dir of [
    "apps/server/src",
    "apps/worker/src",
    "packages/api/src",
    "packages/queue/src",
  ])
    walk(join(root, dir));
  const source = readFileSync(join(root, "apps/worker/src/lib/qwen-child.ts"), "utf8");

  it("only qwen-child.ts references node-llama-cpp, and only through a dynamic import", () => {
    expect(offenders).toEqual(["apps/worker/src/lib/qwen-child.ts"]);
    expect(source).not.toMatch(/^import[^\n]*node-llama-cpp/m);
    expect(source).toMatch(/await import\("node-llama-cpp"\)/);
  });
});

describe("46r9 descriptor driven input and noncausal batch", () => {
  const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
  const tokenize = (text: string) => Array.from(text, () => 42);
  it("empty/default and primary queries/documents include Gemma's prompts and BOS/EOS exactly once", () => {
    for (const purpose of ["document", "query"] as const) {
      const prefix = purpose === "query" ? "task: search result | query: " : "title: none | text: ";
      for (const text of ["", "hello"])
        expect(prepareBuiltinTokens(GEMMA_MODEL, text, purpose, tokenize, 1024)).toEqual([
          2,
          ...tokenize(prefix + text),
          1,
        ]);
    }
    expect(prepareBuiltinTokens(QWEN_MODEL, "hello", "document", tokenize, 1024)).toEqual([
      ...tokenize("hello"),
      EOS,
    ]);
  });
  it("literal special ids fail; limit includes both prompts and special tokens; no truncation", () => {
    for (const id of [1, 2])
      expect(() => prepareBuiltinTokens(GEMMA_MODEL, "x", "document", () => [id], 1024)).toThrow();
    expect(
      prepareBuiltinTokens(GEMMA_MODEL, "x", "document", () => Array(1022).fill(42), 1024),
    ).toHaveLength(1024);
    expect(() =>
      prepareBuiltinTokens(GEMMA_MODEL, "x", "document", () => Array(1023).fill(42), 1024),
    ).toThrow(QwenInputTooLongError);
  });
  it("Gemma cannot split one sequence; batch is full cap, flash and mmap on, oversized/unknown tiers refused", () => {
    for (const contextTokens of GEMMA_MODEL.contextTiers) {
      const options = builtinNativeOptions(GEMMA_MODEL, { ...config, contextTokens }, 3);
      expect(options.context.batchSize).toBe(contextTokens);
      expect(options.model).toMatchObject({ defaultContextFlashAttention: true, useMmap: true });
      expect(() =>
        assertBuiltinBatch(GEMMA_MODEL, contextTokens, contextTokens - 1, contextTokens),
      ).toThrow();
      expect(() =>
        assertBuiltinBatch(GEMMA_MODEL, contextTokens, contextTokens, contextTokens - 1),
      ).toThrow();
      expect(() =>
        assertBuiltinBatch(GEMMA_MODEL, contextTokens, contextTokens, contextTokens),
      ).not.toThrow();
    }
    expect(() =>
      builtinNativeOptions(GEMMA_MODEL, { ...config, contextTokens: 16384 }, 3),
    ).toThrow();
    expect(() => assertBuiltinBatch(QWEN_MODEL, 4096, 512, 512)).not.toThrow();
  });
});

it("gives the native library a typed IPC logger instead of its console default", async () => {
  vi.resetModules();
  vi.doMock("./embedding-runtime", () => ({
    embeddingRuntimeDirectory: () => "/fixture/runtime",
    verifyEmbeddingRuntime: () => ({ files: [] }),
  }));
  vi.doMock("node-llama-cpp", () => ({
    LlamaLogLevel: { error: "error" },
    getLlama: async (options: { logger: (level: string, text: string) => void }) => {
      options.logger("error", "password=NativeCanary9Zq7Kp2Xw");
      throw new Error("fixture ends before native loading");
    },
  }));
  const { loadNativeQwenBackend } = await import("./qwen-child");
  const previous = Object.getOwnPropertyDescriptor(process, "send");
  const send = vi.fn();
  Object.defineProperty(process, "send", { configurable: true, value: send });
  try {
    await expect(
      loadNativeQwenBackend("/fixture/model", DEFAULT_QWEN_RUNTIME_CONFIG),
    ).rejects.toThrow("fixture ends");
    expect(send).toHaveBeenCalledExactlyOnceWith({ t: "library_log" });
  } finally {
    if (previous) Object.defineProperty(process, "send", previous);
    else Reflect.deleteProperty(process, "send");
    vi.doUnmock("node-llama-cpp");
    vi.doUnmock("./embedding-runtime");
  }
});
