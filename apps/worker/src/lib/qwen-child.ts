/**
 * Forked Qwen model child. Bundled as
 * `dist/qwen-child.mjs` and started only by qwen-lifecycle.ts through the
 * native parent-death guard. This is the ONLY module that loads the
 * node-llama-cpp native addon, and only via dynamic import inside the child,
 * so the worker parent never maps it. Process exit is the unload path: in-process
 * dispose leaks ~280 MiB RSS (embed-spike-REPORT.md).
 *
 * The child receives no secrets (the parent passes a minimal env) and returns
 * raw vectors; the parent validates and L2-normalizes them.
 */

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BuiltinModelDescriptor,
  builtinModel,
  EMBEDDING_CMAKE_OPTIONS,
  QWEN_MODEL,
} from "@knowledge-base/api/lib/kb/builtin-model";
import {
  QWEN_KV_GGML_TYPE,
  type QwenRuntimeConfig,
  qwenRuntimeConfigSchema,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import {
  assertLoadedRuntime,
  embeddingRuntimeDirectory,
  verifyEmbeddingRuntime,
} from "./embedding-runtime";

export type QwenPurpose = "query" | "document";
export type ParentToChild =
  | { t: "embed"; token: string; purpose: QwenPurpose; texts: string[] }
  /** Model token counts (prefix/EOS included) for context-fit chunking. */
  | { t: "count"; token: string; purpose: QwenPurpose; texts: string[] }
  /** Load probe: embed one input that fills the configured context exactly. */
  | { t: "probe"; token: string }
  | { t: "shutdown" };
export type ChildToParent =
  | { t: "ready" }
  | { t: "library_log" }
  | { t: "load_failed" }
  | { t: "result"; token: string; vectors: number[][]; peakRssBytes: number | null }
  | { t: "counts"; token: string; counts: number[]; limit: number }
  | { t: "error"; token: string; code: "EMBEDDING_INPUT_TOO_LONG" | "EMBED_FAILED" };

export class QwenInputTooLongError extends Error {
  readonly code = "EMBEDDING_INPUT_TOO_LONG";
  constructor() {
    super("Embedding input too long");
  }
}

/**
 * Queries get the exact instruction prefix; documents stay raw.
 * The tokenizer runs with special-token parsing off and adds no BOS
 * (add_bos=false), so EOS 151643 is appended here exactly once. The whole
 * sequence, prefix and EOS included, must fit the configured context
 * Longer input is rejected, never truncated.
 */
export function prepareBuiltinTokens(
  model: BuiltinModelDescriptor,
  text: string,
  purpose: QwenPurpose,
  tokenize: (input: string) => readonly number[],
  contextTokens: number,
): number[] {
  const tokens = tokenize((purpose === "query" ? model.queryPrefix : model.documentPrefix) + text);
  if (tokens.includes(model.eosTokenId) || tokens.includes(model.bosTokenId))
    throw new Error("tokenizer emitted a special token");
  const prepared = [
    ...(model.addBos ? [model.bosTokenId] : []),
    ...tokens,
    ...(model.addEos ? [model.eosTokenId] : []),
  ];
  if (prepared.length > contextTokens) throw new QwenInputTooLongError();
  return prepared;
}
/** Probe exactly the configured cap, including the descriptor's document prompt/BOS/EOS. */
export function maxContextProbeTokens(
  tokenize: (input: string) => readonly number[],
  contextTokens: number,
  model = QWEN_MODEL,
): number[] {
  const prepared = prepareBuiltinTokens(
    model,
    " a".repeat(contextTokens),
    "document",
    tokenize,
    Infinity,
  );
  const eos = model.addEos ? 1 : 0;
  if (prepared.length < contextTokens) throw new Error("probe filler too short");
  return [...prepared.slice(0, contextTokens - eos), ...(eos ? [model.eosTokenId] : [])];
}

/** The parent passes the admin runtime config through the child's minimal env. */
export function parseQwenChildConfig(
  env: Record<string, string | undefined>,
): QwenRuntimeConfig | null {
  const raw = env.KB_QWEN_CONTEXT_TOKENS;
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) return null;
  const parsed = qwenRuntimeConfigSchema.safeParse({
    contextTokens: Number(raw),
    kvKeyType: env.KB_QWEN_KV_KEY_TYPE,
    kvValueType: env.KB_QWEN_KV_VALUE_TYPE,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * node-llama-cpp options for a runtime config (names verified in the 3.22.2
 * LlamaModel.d.ts). Qwen retains causal 512-token batches through its KV
 * cache. Gemma requires one full sequence: the binding sets native
 * n_batch and n_ubatch to batchSize (AddonContext.cpp), and the embedding
 * context contains only one sequence. Flash attention and mmap stay on.
 */
export function assertBuiltinBatch(
  model: BuiltinModelDescriptor,
  tokens: number,
  batch: number,
  ubatch: number,
) {
  if (!model.causal && (batch < tokens || ubatch < tokens))
    throw new Error("noncausal input requires one full batch");
}
export function builtinNativeOptions(
  model: BuiltinModelDescriptor,
  config: {
    contextTokens: number;
    kvKeyType: QwenRuntimeConfig["kvKeyType"];
    kvValueType: QwenRuntimeConfig["kvValueType"];
  },
  cpuThreads = availableParallelism(),
) {
  if (!model.causal && !model.contextTiers.includes(config.contextTokens))
    throw new Error("unsupported model context");
  return {
    model: {
      useMmap: true,
      defaultContextFlashAttention: true,
      experimentalDefaultContextKvCacheKeyType: QWEN_KV_GGML_TYPE[config.kvKeyType],
      experimentalDefaultContextKvCacheValueType: QWEN_KV_GGML_TYPE[config.kvValueType],
    },
    context: {
      contextSize: config.contextTokens + 1,
      batchSize: model.batchTokens === "full-input" ? config.contextTokens : model.batchTokens,
      threads: Math.max(1, Math.min(6, Math.floor(cpuThreads))),
    },
  } as const;
}
export function qwenNativeOptions(config: QwenRuntimeConfig, cpuThreads = availableParallelism()) {
  return builtinNativeOptions(QWEN_MODEL, config, cpuThreads);
}

/** VmHWM (peak resident set) from /proc/<pid>/status text, in bytes. */
export function readVmHwmBytes(status: string): number | null {
  const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

function readOwnPeakRssBytes(): number | null {
  try {
    return readVmHwmBytes(readFileSync("/proc/self/status", "utf8"));
  } catch {
    return null;
  }
}

export type QwenBackend = {
  tokenize(text: string): readonly number[];
  embed(tokens: readonly number[]): Promise<ArrayLike<number>>;
  dispose(): Promise<void>;
};

/** Native backend: verified patched CPU source build; no runtime build/download fallback. */
export async function loadNativeQwenBackend(
  modelPath: string,
  config: QwenRuntimeConfig,
  descriptor = QWEN_MODEL,
): Promise<QwenBackend> {
  const options = builtinNativeOptions(descriptor, config);
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("node-llama-cpp"))));
  const runtimeDir = embeddingRuntimeDirectory(packageRoot);
  const verified = verifyEmbeddingRuntime(runtimeDir);
  const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
  const llama = await getLlama({
    gpu: false,
    build: "never",
    usePrebuiltBinaries: false,
    cmakeOptions: EMBEDDING_CMAKE_OPTIONS,
    skipDownload: true,
    progressLogs: false,
    logLevel: LlamaLogLevel.error,
    logger: () => process.send?.({ t: "library_log" } satisfies ChildToParent),
  });
  assertLoadedRuntime(llama, runtimeDir, readFileSync("/proc/self/maps", "utf8"), verified.files);
  const model = await llama.loadModel({ modelPath, ...options.model });
  const metadata = model.fileInfo.metadata as Record<string, { pooling_type?: unknown }>;
  if (
    model.tokens.eos !== descriptor.eosTokenId ||
    (descriptor.addBos && model.tokens.bos !== descriptor.bosTokenId) ||
    model.tokens.shouldPrependBosToken !== descriptor.addBos ||
    model.tokens.shouldAppendEosToken !== descriptor.addEos ||
    model.embeddingVectorSize !== descriptor.dimensions ||
    metadata[descriptor.architecture]?.pooling_type !== descriptor.poolingType // node-llama-cpp pools from checked GGUF metadata
  ) {
    await model.dispose();
    throw new Error("model metadata mismatch");
  }
  const context = await model.createEmbeddingContext(options.context);
  return {
    tokenize: (text) => model.tokenize(text, false),
    // Token is a branded number in node-llama-cpp; ids come from model.tokenize.
    embed: async (tokens) => {
      assertBuiltinBatch(
        descriptor,
        tokens.length,
        options.context.batchSize,
        options.context.batchSize,
      );
      return (
        await context.getEmbeddingFor([...tokens] as unknown as Parameters<
          typeof context.getEmbeddingFor
        >[0])
      ).vector;
    },
    dispose: async () => {
      await context.dispose();
      await model.dispose();
      await llama.dispose();
    },
  };
}

export type QwenChildIo = {
  send(message: ChildToParent): void;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  exit(code: number): void;
};

function parseProbe(message: unknown): Extract<ParentToChild, { t: "probe" }> | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  return m.t === "probe" && typeof m.token === "string" ? { t: "probe", token: m.token } : null;
}

function parseEmbed(
  message: unknown,
): Extract<ParentToChild, { t: "embed" }> | Extract<ParentToChild, { t: "count" }> | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  if (
    (m.t !== "embed" && m.t !== "count") ||
    typeof m.token !== "string" ||
    (m.purpose !== "query" && m.purpose !== "document") ||
    !Array.isArray(m.texts) ||
    m.texts.length > 32 ||
    !m.texts.every((text) => typeof text === "string")
  )
    return null;
  return { t: m.t, token: m.token, purpose: m.purpose, texts: m.texts as string[] };
}

/** One execution at a time; the parent never sends a second embed before a reply. */
export async function runQwenChild(
  io: QwenChildIo,
  loadBackend: () => Promise<QwenBackend>,
  options: {
    contextTokens: number;
    readPeakRssBytes: () => number | null;
    descriptor?: BuiltinModelDescriptor;
  },
): Promise<void> {
  const descriptor = options.descriptor ?? QWEN_MODEL;
  // A lost parent means no one can consume results: exit immediately.
  io.onDisconnect(() => io.exit(1));
  let backend: QwenBackend;
  try {
    backend = await loadBackend();
  } catch {
    io.send({ t: "load_failed" });
    io.exit(1);
    return;
  }
  let queue = Promise.resolve();
  io.onMessage((message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { t?: unknown }).t === "shutdown"
    ) {
      queue = queue.then(async () => {
        await backend.dispose().catch(() => {});
        io.exit(0);
      });
      return;
    }
    const probe = parseProbe(message);
    if (probe) {
      queue = queue.then(async () => {
        try {
          const tokens = maxContextProbeTokens(
            (input) => backend.tokenize(input),
            options.contextTokens,
            descriptor,
          );
          const vector = Array.from(await backend.embed(tokens));
          io.send({
            t: "result",
            token: probe.token,
            vectors: [vector],
            peakRssBytes: options.readPeakRssBytes(),
          });
        } catch {
          io.send({ t: "error", token: probe.token, code: "EMBED_FAILED" });
        }
      });
      return;
    }
    const embed = parseEmbed(message);
    if (!embed) return;
    if (embed.t === "count") {
      queue = queue.then(async () => {
        try {
          const counts = embed.texts.map(
            (text) =>
              prepareBuiltinTokens(
                descriptor,
                text,
                embed.purpose,
                (input) => backend.tokenize(input),
                Infinity,
              ).length,
          );
          io.send({ t: "counts", token: embed.token, counts, limit: options.contextTokens });
        } catch {
          io.send({ t: "error", token: embed.token, code: "EMBED_FAILED" });
        }
      });
      return;
    }
    queue = queue.then(async () => {
      try {
        // Tokenize the whole batch before any native execute.
        const batches = embed.texts.map((text) =>
          prepareBuiltinTokens(
            descriptor,
            text,
            embed.purpose,
            (input) => backend.tokenize(input),
            options.contextTokens,
          ),
        );
        const vectors: number[][] = [];
        for (const tokens of batches) vectors.push(Array.from(await backend.embed(tokens)));
        io.send({
          t: "result",
          token: embed.token,
          vectors,
          peakRssBytes: options.readPeakRssBytes(),
        });
      } catch (error) {
        io.send({
          t: "error",
          token: embed.token,
          code:
            error instanceof QwenInputTooLongError ? "EMBEDDING_INPUT_TOO_LONG" : "EMBED_FAILED",
        });
      }
    });
  });
  io.send({ t: "ready" });
}

if (process.env.KB_QWEN_CHILD === "1" && typeof process.send === "function") {
  const modelPath = process.env.KB_QWEN_MODEL_PATH ?? "";
  // A missing/invalid config fails the load (fail closed), never a default.
  const config = parseQwenChildConfig(process.env);
  let descriptor: BuiltinModelDescriptor | undefined;
  try {
    descriptor = builtinModel(process.argv[2] ?? QWEN_MODEL.modelId);
  } catch {}
  void runQwenChild(
    {
      send: (message) => process.send?.(message),
      onMessage: (listener) => process.on("message", listener),
      onDisconnect: (listener) => process.on("disconnect", listener),
      exit: (code) => process.exit(code),
    },
    async () => {
      if (!config || !descriptor) throw new Error("invalid runtime config");
      return loadNativeQwenBackend(modelPath, config, descriptor);
    },
    {
      contextTokens: config?.contextTokens ?? 0,
      readPeakRssBytes: readOwnPeakRssBytes,
      descriptor,
    },
  );
}
