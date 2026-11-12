import { builtinModel } from "@knowledge-base/api/lib/kb/builtin-model";
/**
 * Runtime capability probe for the selected built-in model.
 *
 * The model becomes READY (executable, attachable by every user) only after the
 * checksum-verified artifact was actually loaded and embedded by the real forked
 * child through the parent-death guard, using the pinned patched node-llama-cpp CPU
 * source build. Any failure — no verified binary for this platform, missing guard/child
 * bundle (dev outside the image), GGUF metadata mismatch, wrong dimensions,
 * non-finite output, timeout — is MODEL_RUNTIME_UNSUPPORTED with its internal cause retained. There is no
 * compile-from-source or alternative-runtime fallback.
 *
 * The caller (the download attempt) holds the model volume lease, so the probe's
 * supervisor uses a no-op lease. The probe child is always killed and reaped
 * before this returns; the parent never loads the native addon.
 */
import { readModelRuntimeConfig } from "@knowledge-base/api/lib/kb/local-model";
import { ModelArtifactError } from "@knowledge-base/api/lib/kb/model-artifact";
import type { QwenRuntimeConfig } from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { createQwenSupervisor, type QwenSupervisorOptions } from "./qwen-lifecycle";

const QWEN_PROBE_TIMEOUT_MS = 120_000;
const QWEN_PROBE_TEXTS = Object.freeze({
  query: "knowledge base runtime probe",
  // ~620 tokens: more than one 512-token decode batch and below the smallest
  // context option (1024), so the recorded peak RSS includes the full per-batch
  // output buffers of the configured runtime (" a" is one token per word).
  document: `The knowledge base worker verifies its embedding runtime before activation.${" a".repeat(600)}`,
});

export type QwenProbeOptions = Pick<
  QwenSupervisorOptions,
  "childEntry" | "modelPath" | "guardPath" | "spawn" | "pidAlive" | "childEnv" | "budgetBytes"
> & { modelId: string; timeoutMs?: number; config: QwenRuntimeConfig; signal?: AbortSignal };

/** Resolves with the child's measured peak RSS (VmHWM) under `config`, or null if unreported. */
export async function probeQwenRuntime(
  options: QwenProbeOptions,
): Promise<{ dimensions: number; peakRssBytes: number | null }> {
  const descriptor = builtinModel(options.modelId);
  let peakRssBytes: number | null = null;
  const runtime = { modelId: descriptor.modelId, epoch: 0, config: options.config };
  const supervisor = createQwenSupervisor({
    onPeakRss: (bytes) => {
      peakRssBytes = Math.max(peakRssBytes ?? 0, bytes);
    },
    childEntry: options.childEntry,
    modelPath: options.modelPath,
    guardPath: options.guardPath,
    spawn: options.spawn,
    pidAlive: options.pidAlive,
    childEnv: options.childEnv,
    budgetBytes: options.budgetBytes,
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
  });
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(options.signal?.reason ?? new Error("Model runtime probe cancelled."));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let run: Promise<{ dimensions: number; peakRssBytes: number | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Model runtime probe deadline exceeded.");
      controller.abort(error);
      reject(error);
    }, options.timeoutMs ?? QWEN_PROBE_TIMEOUT_MS);
  });
  try {
    run = (async () => {
      const [query] = await supervisor.embed({
        purpose: "query",
        texts: [QWEN_PROBE_TEXTS.query],
        runtime,
        signal: controller.signal,
      });
      const [document] = await supervisor.embed({
        purpose: "document",
        texts: [QWEN_PROBE_TEXTS.document],
        runtime,
        signal: controller.signal,
      });
      for (const vector of [query, document]) {
        // The supervisor validated count/dims/finite and a non-zero norm; vectors stay raw
        // (the index format normalizes exactly once, §1.4).
        if (vector?.length !== descriptor.dimensions) throw new Error("probe dimensions");
        const norm = Math.hypot(...vector);
        if (!Number.isFinite(norm) || norm <= 0) throw new Error("probe norm");
      }
      // The representative inputs validate both prompt paths. Admission also
      // requires a max-context embedding, with the first child reaped before
      // loading this probe so enable never needs two model heaps.
      await supervisor.suspend();
      const maximum = await supervisor.probe(runtime, {
        signal: controller.signal,
        timeoutMs: options.timeoutMs,
      });
      peakRssBytes = Math.max(peakRssBytes ?? 0, maximum.peakRssBytes ?? 0) || null;
      return { dimensions: descriptor.dimensions, peakRssBytes };
    })();
    // A deadline win leaves `run` to reject after close(); never unhandled.
    run.catch(() => {});
    return await Promise.race([run, deadline]);
  } catch (cause) {
    throw new ModelArtifactError(
      options.signal?.aborted ? "MODEL_CANCELLED" : "MODEL_RUNTIME_UNSUPPORTED",
      false,
      { cause: controller.signal.aborted ? controller.signal.reason : cause },
    );
  } finally {
    clearTimeout(timer);
    // Kill + reap; resolves only after the OS exit was observed.
    options.signal?.removeEventListener("abort", cancel);
    await supervisor.close();
    await run?.catch(() => {});
  }
}

/** Production enable verifier: configuration I/O and native probe share one budget. */
export async function verifyQwenRuntime(
  options: Omit<QwenProbeOptions, "config"> & { connectionString: string; modelId: string },
) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(options.signal?.reason ?? new Error("Model verification cancelled"));
  const deadlineAt = Date.now() + (options.timeoutMs ?? QWEN_PROBE_TIMEOUT_MS);
  const timer = setTimeout(cancel, Math.max(0, deadlineAt - Date.now()));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const { modelId, ...config } = await readModelRuntimeConfig(
      { connectionString: options.connectionString },
      { signal: controller.signal, deadlineAt },
    );
    controller.signal.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new Error("Model verification deadline exceeded");
    if (modelId !== options.modelId) throw new Error("Superseded model selection");
    const probed = await probeQwenRuntime({
      ...options,
      config,
      signal: controller.signal,
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
    });
    return { ...probed, config };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
