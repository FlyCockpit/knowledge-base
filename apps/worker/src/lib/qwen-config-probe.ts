/**
 * A new built-in runtime config takes effect only after a load probe
 * (load + one max-context embedding) succeeded in this worker.
 *
 * One tick (never overlapping within a process; the DB claim serializes
 * workers):
 * 1. Nothing pending, or the model not READY: idle.
 * 2. A claim whose lease expired means a worker died mid-probe: the request is
 *    failed as MODEL_CONFIG_PROBE_INTERRUPTED (never re-probed automatically —
 *    the config may be what killed it). The active config was never changed,
 *    so every worker simply keeps running the last good config.
 * 3. Take a hold on the model volume lease (only the worker that owns the
 *    volume can run a child); a lease held elsewhere leaves it to that worker.
 * 4. The estimator (chooseBuiltinProbeMode) picks side by side (no gap) or
 *    stop-then-probe (suspend serving: search degrades to lexical + notice
 *    while the claim is live; documents wait).
 * 5. Claim (CAS on probeEpoch), probe with a renewed claim, then commit (the
 *    config switches, its SYSTEM_BUILTIN revision is created and re-embedding is
 *    queued, all in one authority transaction) or fail (last good config stays;
 *    the admin sees the error). A lost claim (a newer admin request) aborts the
 *    probe and records nothing.
 * 6. Always resume serving (on whatever config is now active: the new one after
 *    a commit, else the last good one) and drop the lease hold.
 *
 * Ownership order: volume lease hold -> DB claim -> probe child; released in
 * reverse (claim settled, serving resumed, hold dropped).
 */

import { builtinModel } from "@knowledge-base/api/lib/kb/builtin-model";
import {
  assessBuiltinRuntimeConfig,
  chooseBuiltinProbeMode,
  type QwenProbeMode,
  type QwenRuntimeConfig,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { QwenProbeError, type QwenReadyRuntime } from "./qwen-lifecycle";

export const QWEN_CONFIG_PROBE_TICK_MS = 5_000;
export const QWEN_CONFIG_PROBE_CLAIM_MS = 60_000;
const CLAIM_RENEW_MS = 15_000;

export type QwenConfigProbeErrorCode =
  | "MODEL_CONFIG_PROBE_FAILED"
  | "MODEL_CONFIG_PROBE_TIMEOUT"
  | "MODEL_CONFIG_PROBE_INTERRUPTED";

export type QwenConfigProbeRead = {
  modelId: string;
  modelEpoch: number;
  active: QwenRuntimeConfig;
  activePeakBytes: number | null;
  pending: {
    modelId: string;
    probeEpoch: number;
    config: QwenRuntimeConfig;
    requiresExclusive?: boolean;
    claim: { owner: string; mode: QwenProbeMode; expired: boolean } | null;
  } | null;
};

export type QwenConfigProbeDeps = {
  owner: string;
  budgetBytes(): number | null;
  /** null when the model is not READY. */
  read(): Promise<QwenConfigProbeRead | null>;
  claim(input: { probeEpoch: number; mode: QwenProbeMode; ttlMs?: number }): Promise<boolean>;
  renew(input: { probeEpoch: number; ttlMs?: number }): Promise<boolean>;
  commit(input: { probeEpoch: number; peakRssBytes: number | null }): Promise<boolean>;
  fail(input: {
    probeEpoch: number;
    code: QwenConfigProbeErrorCode;
    interrupted?: boolean;
  }): Promise<boolean>;
  cleanup?(): Promise<void>;
  prepare?(runtime: QwenReadyRuntime, signal: AbortSignal): Promise<void>;
  signal?: AbortSignal;
  supervisor: {
    tryHoldLease(): Promise<boolean>;
    releaseLeaseHold(): Promise<void>;
    suspend(): Promise<void>;
    resume(): void;
    probe(
      runtime: QwenReadyRuntime,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<{ peakRssBytes: number | null }>;
  };
  renewMs?: number;
  claimMs?: number;
};

export type QwenConfigProbeTick = "idle" | "busy" | "interrupted" | "committed" | "failed" | "lost";

export async function runQwenConfigProbeTick(
  deps: QwenConfigProbeDeps,
): Promise<QwenConfigProbeTick> {
  const state = await deps.read();
  const pending = state?.pending;
  if (!state || !pending) return "idle";
  if (pending.claim) {
    if (!pending.claim.expired) return "busy";
    await deps.fail({
      probeEpoch: pending.probeEpoch,
      code: "MODEL_CONFIG_PROBE_INTERRUPTED",
      interrupted: true,
    });
    return "interrupted";
  }
  if (!(await deps.supervisor.tryHoldLease())) return "busy";
  try {
    const candidateModel = builtinModel(pending.modelId);
    const budgetBytes = deps.budgetBytes();
    const admission = assessBuiltinRuntimeConfig(candidateModel, pending.config, budgetBytes);
    const assessed = chooseBuiltinProbeMode({
      activeModel: builtinModel(state.modelId),
      candidateModel,
      active: state.active,
      activePeakBytes: state.activePeakBytes,
      candidate: pending.config,
      budgetBytes,
    });
    const mode = pending.requiresExclusive ? "exclusive" : assessed.mode;
    const claimMs = deps.claimMs ?? QWEN_CONFIG_PROBE_CLAIM_MS;
    if (!(await deps.claim({ probeEpoch: pending.probeEpoch, mode, ttlMs: claimMs })))
      return "busy";
    // Revalidate persisted intent against this worker's current cgroup limit:
    // an older report or a replacement container cannot authorize an unsafe load.
    if (admission.level === "block" || admission.level === "unknown") {
      const failed = await deps.fail({
        probeEpoch: pending.probeEpoch,
        code: "MODEL_CONFIG_PROBE_FAILED",
      });
      return failed ? "failed" : "lost";
    }
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    deps.signal?.addEventListener("abort", shutdown, { once: true });
    if (deps.signal?.aborted) shutdown();
    let lost = false;
    let renewal: Promise<void> | undefined;
    const renewTimer = setInterval(() => {
      if (renewal) return;
      renewal = deps
        .renew({ probeEpoch: pending.probeEpoch, ttlMs: claimMs })
        .then(
          (ok) => {
            if (!ok) {
              lost = true;
              controller.abort();
            }
          },
          () => {
            lost = true;
            controller.abort();
          },
        )
        .finally(() => {
          renewal = undefined;
        });
    }, deps.renewMs ?? CLAIM_RENEW_MS);
    renewTimer.unref?.();
    let suspended = false;
    try {
      if (mode === "exclusive") {
        await deps.supervisor.suspend();
        suspended = true;
      }
      const runtime = {
        modelId: pending.modelId,
        epoch: state.modelEpoch,
        config: pending.config,
      };
      let outcome: { peakRssBytes: number | null } | QwenConfigProbeErrorCode;
      try {
        await deps.prepare?.(runtime, controller.signal);
        if (controller.signal.aborted) throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
        outcome = await deps.supervisor.probe(runtime, { signal: controller.signal });
      } catch (error) {
        outcome = error instanceof QwenProbeError ? error.code : "MODEL_CONFIG_PROBE_FAILED";
      }
      clearInterval(renewTimer);
      await renewal;
      if (lost || controller.signal.aborted) return "lost";
      if (typeof outcome === "string") {
        const failed = await deps.fail({ probeEpoch: pending.probeEpoch, code: outcome });
        return failed ? "failed" : "lost";
      }
      const committed = await deps.commit({
        probeEpoch: pending.probeEpoch,
        peakRssBytes: outcome.peakRssBytes,
      });
      return committed ? "committed" : "lost";
    } finally {
      clearInterval(renewTimer);
      await renewal;
      deps.signal?.removeEventListener("abort", shutdown);
      if (suspended) deps.supervisor.resume();
    }
  } finally {
    try {
      await deps.cleanup?.();
    } finally {
      await deps.supervisor.releaseLeaseHold();
    }
  }
}
