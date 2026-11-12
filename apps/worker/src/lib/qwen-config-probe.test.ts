/**
 * Orchestration: the estimator picks side-by-side vs stop-then-probe, a
 * config takes effect only after a successful load probe (and only then does
 * re-embedding start), a failed probe keeps the last good config in both
 * branches, and a crash mid-probe resolves to the last good config.
 */
import { GEMMA_MODEL, QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import {
  DEFAULT_QWEN_RUNTIME_CONFIG,
  QWEN_BLOCK_RATIO,
  QWEN_WEIGHTS_BYTES,
  type QwenRuntimeConfig,
  qwenMemoryEstimate,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { describe, expect, it, vi } from "vitest";
import { type QwenConfigProbeDeps, runQwenConfigProbeTick } from "./qwen-config-probe";
import { QwenProbeError } from "./qwen-lifecycle";

const ACTIVE = DEFAULT_QWEN_RUNTIME_CONFIG;
const CANDIDATE: QwenRuntimeConfig = { contextTokens: 8192, kvKeyType: "f16", kvValueType: "f16" };
const COMBINED =
  qwenMemoryEstimate(ACTIVE).bytes + qwenMemoryEstimate(CANDIDATE).bytes - QWEN_WEIGHTS_BYTES;
const ROOMY = Math.ceil(COMBINED / QWEN_BLOCK_RATIO) + 1;
const TIGHT = Math.floor(COMBINED / QWEN_BLOCK_RATIO) - 1;

type Row = {
  modelEpoch: number;
  active: QwenRuntimeConfig;
  activePeakBytes: number | null;
  pending: {
    modelId: string;
    probeEpoch: number;
    config: QwenRuntimeConfig;
    claim: { owner: string; mode: "side-by-side" | "exclusive"; expired: boolean } | null;
  } | null;
  error: string | null;
  reembedQueued: boolean;
};

function harness(options: {
  budget: number | null;
  probe?: () => Promise<{ peakRssBytes: number | null }>;
  holdLease?: boolean;
  row?: Partial<Row>;
}) {
  const row: Row = {
    modelEpoch: 3,
    active: ACTIVE,
    activePeakBytes: null,
    pending: { modelId: QWEN_MODEL.modelId, probeEpoch: 7, config: CANDIDATE, claim: null },
    error: null,
    reembedQueued: false,
    ...options.row,
  };
  const events: string[] = [];
  const supervisor = {
    tryHoldLease: vi.fn(async () => {
      events.push("hold");
      return options.holdLease ?? true;
    }),
    releaseLeaseHold: vi.fn(async () => {
      events.push("release");
    }),
    suspend: vi.fn(async () => {
      events.push("suspend");
    }),
    resume: vi.fn(() => {
      events.push("resume");
    }),
    probe: vi.fn(async (runtime: { epoch: number; config: QwenRuntimeConfig }) => {
      events.push(`probe:${runtime.config.contextTokens}`);
      return (options.probe ?? (async () => ({ peakRssBytes: 2_600_000_000 })))();
    }),
  };
  const deps: QwenConfigProbeDeps = {
    owner: "worker-a",
    budgetBytes: () => options.budget,
    read: async () =>
      row.pending === null
        ? {
            modelId: QWEN_MODEL.modelId,
            modelEpoch: row.modelEpoch,
            active: row.active,
            activePeakBytes: row.activePeakBytes,
            pending: null,
          }
        : {
            modelId: QWEN_MODEL.modelId,
            modelEpoch: row.modelEpoch,
            active: row.active,
            activePeakBytes: row.activePeakBytes,
            pending: row.pending,
          },
    claim: vi.fn(async ({ probeEpoch, mode }) => {
      const pending = row.pending;
      if (!pending || pending.probeEpoch !== probeEpoch || pending.claim) return false;
      pending.claim = { owner: "worker-a", mode, expired: false };
      events.push(`claim:${mode}`);
      return true;
    }),
    renew: vi.fn(async () => true),
    commit: vi.fn(async ({ probeEpoch }) => {
      const pending = row.pending;
      if (!pending || pending.probeEpoch !== probeEpoch) return false;
      row.active = pending.config;
      row.pending = null;
      // The re-embed queue is written only by the commit (retargetSystemBuiltinKbs).
      row.reembedQueued = true;
      events.push("commit");
      return true;
    }),
    fail: vi.fn(async ({ probeEpoch, code }) => {
      if (!row.pending || row.pending.probeEpoch !== probeEpoch) return false;
      row.pending = null;
      row.error = code;
      events.push(`fail:${code}`);
      return true;
    }),
    supervisor,
  };
  return { row, events, deps, supervisor };
}

describe("runQwenConfigProbeTick", () => {
  it("exactly90% combined memory suspends serving before probing, then resumes after commit", async () => {
    const h = harness({ budget: COMBINED / 0.9 });
    expect(await runQwenConfigProbeTick(h.deps)).toBe("committed");
    expect(h.events).toEqual([
      "hold",
      "claim:exclusive",
      "suspend",
      "probe:8192",
      "commit",
      "resume",
      "release",
    ]);
    expect(h.row.active).toEqual(CANDIDATE);
    expect(h.row.reembedQueued).toBe(true);
  });
  it("does nothing without a pending config or without a READY model", async () => {
    const idle = harness({ budget: ROOMY, row: { pending: null } });
    expect(await runQwenConfigProbeTick(idle.deps)).toBe("idle");
    expect(idle.supervisor.tryHoldLease).not.toHaveBeenCalled();
    const notReady = harness({ budget: ROOMY });
    notReady.deps.read = async () => null;
    expect(await runQwenConfigProbeTick(notReady.deps)).toBe("idle");
  });

  it("fits under 90%: probes side by side (no gap) and switches only on success; re-embed starts after", async () => {
    const h = harness({ budget: ROOMY });
    expect(await runQwenConfigProbeTick(h.deps)).toBe("committed");
    expect(h.events).toEqual(["hold", "claim:side-by-side", "probe:8192", "commit", "release"]);
    expect(h.supervisor.suspend).not.toHaveBeenCalled();
    expect(h.row.active).toEqual(CANDIDATE);
    expect(h.row.reembedQueued).toBe(true);
    expect(h.deps.commit).toHaveBeenCalledWith(
      expect.objectContaining({ probeEpoch: 7, peakRssBytes: 2_600_000_000 }),
    );
  });

  it("does not fit: stops the current child, probes, switches on success, then resumes", async () => {
    const h = harness({ budget: TIGHT });
    expect(await runQwenConfigProbeTick(h.deps)).toBe("committed");
    expect(h.events).toEqual([
      "hold",
      "claim:exclusive",
      "suspend",
      "probe:8192",
      "commit",
      "resume",
      "release",
    ]);
    expect(h.row.active).toEqual(CANDIDATE);
  });

  it.each([
    ["side by side", ROOMY, "side-by-side"],
    ["stop-then-probe", TIGHT, "exclusive"],
  ] as const)(
    "%s: a failed probe keeps the last good config active and records the error; no re-embed",
    async (_, budget, mode) => {
      const h = harness({
        budget,
        probe: async () => {
          throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
        },
      });
      expect(await runQwenConfigProbeTick(h.deps)).toBe("failed");
      expect(h.row.active).toEqual(ACTIVE);
      expect(h.row.pending).toBeNull();
      expect(h.row.error).toBe("MODEL_CONFIG_PROBE_FAILED");
      expect(h.row.reembedQueued).toBe(false);
      expect(h.deps.commit).not.toHaveBeenCalled();
      expect(h.events).toContain(`claim:${mode}`);
      if (mode === "exclusive") {
        // The old config is restarted: the supervisor resumes on the last good runtime.
        expect(h.events.indexOf("resume")).toBeGreaterThan(
          h.events.indexOf("fail:MODEL_CONFIG_PROBE_FAILED"),
        );
      } else expect(h.supervisor.suspend).not.toHaveBeenCalled();
      expect(h.events.at(-1)).toBe("release");
    },
  );

  it("an unexpected probe error is still a failed probe with a fixed code", async () => {
    const h = harness({
      budget: TIGHT,
      probe: async () => {
        throw new Error("native detail");
      },
    });
    expect(await runQwenConfigProbeTick(h.deps)).toBe("failed");
    expect(h.row.error).toBe("MODEL_CONFIG_PROBE_FAILED");
    expect(h.supervisor.resume).toHaveBeenCalledTimes(1);
  });

  it("crash mid-probe: an expired claim is failed as interrupted; the last good config stays active", async () => {
    const h = harness({
      budget: TIGHT,
      row: {
        pending: {
          modelId: QWEN_MODEL.modelId,
          probeEpoch: 7,
          config: CANDIDATE,
          claim: { owner: "worker-dead", mode: "exclusive", expired: true },
        },
      },
    });
    expect(await runQwenConfigProbeTick(h.deps)).toBe("interrupted");
    expect(h.deps.fail).toHaveBeenCalledWith({
      probeEpoch: 7,
      code: "MODEL_CONFIG_PROBE_INTERRUPTED",
      interrupted: true,
    });
    expect(h.row.active).toEqual(ACTIVE);
    expect(h.row.error).toBe("MODEL_CONFIG_PROBE_INTERRUPTED");
    // Never re-probes a config that may have killed the worker.
    expect(h.supervisor.probe).not.toHaveBeenCalled();
    expect(h.row.reembedQueued).toBe(false);
  });

  it("a live claim by another worker, or a volume lease held elsewhere, leaves the probe alone", async () => {
    const claimed = harness({
      budget: ROOMY,
      row: {
        pending: {
          modelId: QWEN_MODEL.modelId,
          probeEpoch: 7,
          config: CANDIDATE,
          claim: { owner: "worker-b", mode: "side-by-side", expired: false },
        },
      },
    });
    expect(await runQwenConfigProbeTick(claimed.deps)).toBe("busy");
    expect(claimed.supervisor.probe).not.toHaveBeenCalled();
    const busy = harness({ budget: ROOMY, holdLease: false });
    expect(await runQwenConfigProbeTick(busy.deps)).toBe("busy");
    expect(busy.deps.claim).not.toHaveBeenCalled();
    expect(busy.supervisor.releaseLeaseHold).not.toHaveBeenCalled();
  });

  it("a lost claim (newer admin request) aborts the probe and commits nothing", async () => {
    let seenSignal: AbortSignal | undefined;
    const h = harness({ budget: TIGHT });
    h.supervisor.probe.mockImplementation(async (_runtime, opts?: { signal?: AbortSignal }) => {
      seenSignal = opts?.signal;
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
    });
    h.deps.renew = vi.fn(async () => false);
    h.deps.renewMs = 5;
    expect(await runQwenConfigProbeTick(h.deps)).toBe("lost");
    expect(seenSignal?.aborted).toBe(true);
    expect(h.deps.commit).not.toHaveBeenCalled();
    expect(h.deps.fail).not.toHaveBeenCalled();
    expect(h.supervisor.resume).toHaveBeenCalledTimes(1);
    expect(h.supervisor.releaseLeaseHold).toHaveBeenCalledTimes(1);
  });

  it("uses the recorded peak of the running config for the placement decision", async () => {
    const h = harness({
      budget: ROOMY,
      row: { activePeakBytes: qwenMemoryEstimate(ACTIVE).bytes + 1024 ** 3 },
    });
    await runQwenConfigProbeTick(h.deps);
    expect(h.events).toContain("claim:exclusive");
  });
  it("shutdown aborts artifact preparation and a late successful probe cannot commit", async () => {
    const controller = new AbortController();
    const h = harness({
      budget: TIGHT,
      probe: async () => {
        controller.abort();
        return { peakRssBytes: 1 };
      },
    });
    h.deps.signal = controller.signal;
    h.deps.prepare = vi.fn(async (_, signal) => {
      expect(signal.aborted).toBe(false);
    });
    expect(await runQwenConfigProbeTick(h.deps)).toBe("lost");
    expect(h.deps.commit).not.toHaveBeenCalled();
    expect(h.row.active).toEqual(ACTIVE);
    expect(h.events).toContain("resume");
    expect(h.events.at(-1)).toBe("release");
  });
  it.each([null, 512 * 1024 ** 2])(
    "rechecks candidate admission at the worker's current budget (%s), failing before download or child spawn",
    async (budget) => {
      const h = harness({ budget });
      h.deps.prepare = vi.fn(async () => {});
      expect(await runQwenConfigProbeTick(h.deps)).toBe("failed");
      expect(h.deps.prepare).not.toHaveBeenCalled();
      expect(h.supervisor.probe).not.toHaveBeenCalled();
      expect(h.supervisor.suspend).not.toHaveBeenCalled();
      expect(h.row.active).toEqual(ACTIVE);
      expect(h.row.reembedQueued).toBe(false);
    },
  );
});

it("R45 one pending claim renewal is joined before commit and volume release", async () => {
  const probed = Promise.withResolvers<{ peakRssBytes: number | null }>();
  const renewed = Promise.withResolvers<boolean>();
  const h = harness({ budget: ROOMY, probe: () => probed.promise });
  h.deps.renewMs = 5;
  h.deps.renew = vi.fn(() => renewed.promise);
  const running = runQwenConfigProbeTick(h.deps);
  await vi.waitFor(() => expect(h.deps.renew).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.deps.renew).toHaveBeenCalledTimes(1);
  probed.resolve({ peakRssBytes: 2_600_000_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.deps.commit).not.toHaveBeenCalled();
  expect(h.supervisor.releaseLeaseHold).not.toHaveBeenCalled();
  renewed.resolve(true);
  expect(await running).toBe("committed");
  expect(h.deps.commit).toHaveBeenCalledTimes(1);
  expect(h.supervisor.releaseLeaseHold).toHaveBeenCalledTimes(1);
});

it("probes the pending model explicitly when it differs from the active model", async () => {
  const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
  const h = harness({
    budget: 64 * 1024 ** 3,
    row: { pending: { modelId: GEMMA_MODEL.modelId, probeEpoch: 7, config, claim: null } },
  });
  h.deps.prepare = vi.fn(async () => {});
  expect(await runQwenConfigProbeTick(h.deps)).toBe("committed");
  expect(h.deps.prepare).toHaveBeenCalledWith(
    { modelId: GEMMA_MODEL.modelId, epoch: 3, config },
    expect.any(AbortSignal),
  );
  expect(h.supervisor.probe).toHaveBeenCalledWith(
    { modelId: GEMMA_MODEL.modelId, epoch: 3, config },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
