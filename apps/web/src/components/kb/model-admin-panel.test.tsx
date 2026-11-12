import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  awaitingApplied,
  type LocalModelStatusLike,
  ModelRuntimeView,
  ModelStatusView,
  modelControls,
  RuntimeOptionsTable,
  runtimeSelection,
} from "@/components/kb/model-admin-panel";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["admin", "common"],
    defaultNS: "admin",
    resources: { "en-US": { admin: enAdmin, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const M = enAdmin.settings.model;

const status = (patch: Partial<LocalModelStatusLike>): LocalModelStatusLike => ({
  modelId: "qwen3-embedding-0.6b-q8_0",
  fileName: "Qwen3-Embedding-0.6B-Q8_0.gguf",
  sizeBytes: 639150592,
  sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
  state: "DISABLED",
  epoch: 0,
  bytesDownloaded: 0,
  totalBytes: 639150592,
  progress: 0,
  errorCode: null,
  reservedBytes: 0,
  executable: false,
  runtime: {
    contextTokens: 4096,
    kvKeyType: "f16",
    kvValueType: "f16",
    batchTokens: 512,
    flashAttention: true,
  },
  memory: { budgetBytes: null, availableBytes: null, source: null, reportedAt: null },
  peakRssBytes: null,
  estimates: [],
  reembed: { total: 0, done: 0, failed: 0, currentKbId: null },
  pendingConfig: null,
  configError: null,
  removalPending: false,
  ...patch,
});

const GiB = 1024 ** 3;
type Kv = "f16" | "q8_0" | "q4_0";
/** Estimate rows as the server projects them (bytes/percent/level against a 4 GiB budget). */
function estimates(budget: number | null) {
  const rows: LocalModelStatusLike["estimates"] = [];
  for (const contextTokens of [1024, 2048, 4096, 8192, 16384, 32768])
    for (const kvKeyType of ["f16", "q8_0", "q4_0"] as Kv[])
      for (const kvValueType of ["f16", "q8_0", "q4_0"] as Kv[]) {
        const bytes = (1.5 + contextTokens / 8192) * GiB;
        const percent = budget === null ? null : (bytes / budget) * 100;
        rows.push({
          modelId: "qwen3-embedding-0.6b-q8_0",
          contextTokens,
          kvKeyType,
          kvValueType,
          bytes,
          source: contextTokens <= 8192 && kvKeyType === kvValueType ? "measured" : "estimated",
          percent,
          level:
            percent === null ? "unknown" : percent > 90 ? "block" : percent > 70 ? "warn" : "ok",
        });
      }
  return rows;
}

describe("model admin controls", () => {
  it("offers enable when disabled or failed and disable while downloading or ready", () => {
    expect(modelControls(status({ state: "DISABLED" }))).toEqual({
      enable: true,
      disable: false,
      remove: true,
    });
    expect(modelControls(status({ state: "FAILED" }))).toEqual({
      enable: true,
      disable: true,
      remove: true,
    });
    expect(modelControls(status({ state: "DOWNLOADING" }))).toEqual({
      enable: false,
      disable: true,
      remove: false,
    });
    expect(modelControls(status({ state: "READY" }))).toEqual({
      enable: false,
      disable: true,
      remove: false,
    });
  });

  it("offers Remove only once disabled or failed and not while a removal is pending", () => {
    expect(modelControls(status({ state: "DISABLED", removalPending: true })).remove).toBe(false);
    expect(modelControls(status({ state: "READY", removalPending: false })).remove).toBe(false);
  });

  it("keeps polling after Apply until the applied selection is active or failed (R2-23)", () => {
    const applied = {
      modelId: "embeddinggemma-2-q8_0",
      contextTokens: 1024,
      kvKeyType: "f16" as const,
      kvValueType: "f16" as const,
    };
    expect(awaitingApplied(status({}), null)).toBe(false);
    expect(awaitingApplied(status({}), applied)).toBe(true);
    expect(
      awaitingApplied(
        status({
          modelId: "embeddinggemma-2-q8_0",
          runtime: { ...status({}).runtime, contextTokens: 1024 },
        }),
        applied,
      ),
    ).toBe(false);
    expect(
      awaitingApplied(
        status({
          configError: {
            contextTokens: applied.contextTokens,
            kvKeyType: applied.kvKeyType,
            kvValueType: applied.kvValueType,
            code: "MODEL_CONFIG_PROBE_FAILED",
            at: "2026-10-23T00:00:00.000Z",
          },
        }),
        applied,
      ),
    ).toBe(false);
  });
});

describe("model status view", () => {
  it("shows the exact artifact identity and the actual state", () => {
    const html = render(<ModelStatusView status={status({})} />);
    expect(html).toContain("Qwen3-Embedding-0.6B-Q8_0.gguf");
    expect(html).toContain("06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439");
    expect(html).toContain('data-state="DISABLED"');
    expect(html).toContain(M.states.DISABLED);
  });

  it("shows bounded progress and reserved disk while downloading", () => {
    const html = render(
      <ModelStatusView
        status={status({
          state: "DOWNLOADING",
          epoch: 1,
          bytesDownloaded: 319575296,
          progress: 0.5,
          reservedBytes: 639150592,
        })}
      />,
    );
    expect(html).toContain('data-state="DOWNLOADING"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("50%");
    expect(html).toContain("609.5 MiB");
  });

  it("shows a fixed, translated failure message rather than raw error text", () => {
    const html = render(
      <ModelStatusView
        status={status({ state: "FAILED", errorCode: "MODEL_CHECKSUM_MISMATCH" })}
      />,
    );
    expect(html).toContain(M.errors.MODEL_CHECKSUM_MISMATCH);
  });

  it("only READY with executable=true is presented as usable by every user", () => {
    const ready = render(
      <ModelStatusView
        status={status({ state: "READY", progress: 1, epoch: 1, executable: true })}
      />,
    );
    expect(ready).toContain(M.states.READY);
    expect(ready).toContain(M.executable);
    expect(ready).not.toContain('data-testid="model-not-executable"');
    const downloading = render(
      <ModelStatusView status={status({ state: "DOWNLOADING", executable: false })} />,
    );
    expect(downloading).toContain(M.notExecutable);
    expect(downloading).not.toContain('data-testid="model-executable"');
  });
});

describe("runtime config", () => {
  const R = M.runtime;
  const ready = (patch: Partial<LocalModelStatusLike> = {}) =>
    status({
      state: "READY",
      executable: true,
      memory: {
        budgetBytes: 4 * GiB,
        availableBytes: 3 * GiB,
        source: "cgroup-v2",
        reportedAt: "2026-09-26T12:00:00.000Z",
      },
      estimates: estimates(4 * GiB),
      ...patch,
    });

  it("shows the current config, fixed batch/flash attention, the budget and the real peak next to the estimate", () => {
    const html = render(<ModelRuntimeView status={ready({ peakRssBytes: 1.9 * GiB })} />);
    expect(html).toContain("4096");
    expect(html).toContain("512");
    expect(html).toContain("4096.0 MiB"); // budget
    expect(html).toContain("1945.6 MiB"); // real peak (VmHWM)
    expect(html).toContain("2048.0 MiB"); // estimate of the current option (1.5 + 0.5 GiB)
    expect(html).toContain(R.budgetSource["cgroup-v2"]);
    expect(html).toContain('data-testid="runtime-peak"');
  });

  it("says when the worker has not reported a budget or no peak was observed yet", () => {
    const html = render(<ModelRuntimeView status={ready({ memory: status({}).memory })} />);
    expect(html).toContain(R.budgetUnknown);
    expect(html).toContain(R.peakUnknown);
  });

  it("shows sequential re-embedding progress (done / total, current KB)", () => {
    const html = render(
      <ModelRuntimeView
        status={ready({ reembed: { total: 3, done: 1, failed: 0, currentKbId: "k".repeat(24) } })}
      />,
    );
    expect(html).toContain('data-testid="reembed-progress"');
    expect(html).toContain("1 / 3");
    expect(html).toContain("k".repeat(24));
    expect(render(<ModelRuntimeView status={ready()} />)).not.toContain(
      'data-testid="reembed-progress"',
    );
  });

  it("shows a requested config as pending until its load probe succeeds", () => {
    const pending = (state: "queued" | "probing", mode: "side-by-side" | "exclusive" | null) =>
      render(
        <ModelRuntimeView
          status={ready({
            pendingConfig: {
              modelId: "qwen3-embedding-0.6b-q8_0",
              contextTokens: 8192,
              kvKeyType: "q8_0",
              kvValueType: "q4_0",
              state,
              mode,
            },
          })}
        />,
      );
    const queued = pending("queued", null);
    expect(queued).toContain('data-testid="runtime-pending"');
    expect(queued).toContain("8192");
    expect(queued).toContain(R.pending.queued.split("{{")[0]!);
    expect(pending("probing", "side-by-side")).toContain(R.pending.probing.split("{{")[0]!);
    const exclusive = pending("probing", "exclusive");
    expect(exclusive).toContain(R.pending.probingExclusive.split("{{")[0]!);
    expect(render(<ModelRuntimeView status={ready()} />)).not.toContain(
      'data-testid="runtime-pending"',
    );
  });

  it.each([
    "MODEL_CONFIG_PROBE_FAILED",
    "MODEL_CONFIG_PROBE_TIMEOUT",
    "MODEL_CONFIG_PROBE_INTERRUPTED",
  ] as const)("shows a rejected config (%s) with the last good config still active", (code) => {
    const html = render(
      <ModelRuntimeView
        status={ready({
          configError: {
            code,
            contextTokens: 32768,
            kvKeyType: "q4_0",
            kvValueType: "q4_0",
            at: "2026-09-26T10:00:00.000Z",
          },
        })}
      />,
    );
    expect(html).toContain('data-testid="runtime-config-error"');
    expect(html).toContain("32768");
    expect(html).toContain(R.probeError[code].split("{{")[0]!);
    // The active config line is unchanged.
    expect(html).toContain("Context 4096 tokens");
  });

  it("lists every context option for the chosen cache types with estimate, % of budget, source and level", () => {
    const html = render(
      <RuntimeOptionsTable status={ready()} kvKeyType="f16" kvValueType="f16" selected={8192} />,
    );
    for (const context of ["1024", "2048", "4096", "8192", "16384", "32768"])
      expect(html).toContain(`data-context="${context}"`);
    expect(html).toContain(R.source.measured);
    expect(html).toContain(R.source.estimated);
    expect(html).toContain(R.level.warn);
    expect(html).toContain(R.level.block);
    expect(html).toContain('data-level="block"');
    expect(html).toContain('aria-current="true"');
  });

  it("selection: block cannot apply, warn needs acknowledgement, a change triggers re-indexing, unchanged is a no-op", () => {
    const s = ready();
    const at = (contextTokens: number) =>
      runtimeSelection(s, {
        modelId: s.modelId,
        contextTokens,
        kvKeyType: "f16",
        kvValueType: "f16",
      });
    expect(at(4096)).toMatchObject({ changed: false, canApply: false });
    // 1.5 + 1 = 2.5 GiB of 4 GiB = 62.5%: ok.
    expect(at(8192)).toMatchObject({ level: "ok", changed: true, needsAck: false, canApply: true });
    // 1.5 + 2 = 3.5 GiB = 87.5%: warn.
    expect(at(16384)).toMatchObject({ level: "warn", needsAck: true, canApply: true });
    // 1.5 + 4 = 5.5 GiB = 137%: block.
    expect(at(32768)).toMatchObject({ level: "block", canApply: false });
    // No budget reported: nothing can be applied (the server fails closed too).
    const unknown = status({ state: "READY", estimates: estimates(null) });
    expect(
      runtimeSelection(unknown, {
        modelId: unknown.modelId,
        contextTokens: 8192,
        kvKeyType: "f16",
        kvValueType: "f16",
      }),
    ).toMatchObject({ level: "unknown", canApply: false });
  });
});

describe("46r10 registry view", () => {
  it("lists both models, recommendation, smaller alternatives and disabled blocked options with a translated reason", () => {
    const rows = [
      {
        modelId: "embeddinggemma-2-q8_0",
        contextTokens: 1024,
        kvKeyType: "f16" as const,
        kvValueType: "f16" as const,
        bytes: 1100 * 1024 ** 2,
        source: "estimated" as const,
        percent: 55,
        level: "ok" as const,
        recommended: true,
        smaller: false,
      },
      {
        modelId: "qwen3-embedding-0.6b-q8_0",
        contextTokens: 8192,
        kvKeyType: "f16" as const,
        kvValueType: "f16" as const,
        bytes: 2000 * 1024 ** 2,
        source: "estimated" as const,
        percent: 100,
        level: "block" as const,
        recommended: false,
        smaller: false,
      },
    ];
    rows.push({
      ...rows[0]!,
      modelId: "qwen3-embedding-0.6b-q8_0",
      bytes: 900 * 1024 ** 2,
      percent: 45,
      recommended: false,
      smaller: true,
    });
    const html = render(
      <RuntimeOptionsTable
        status={status({ estimates: rows })}
        kvKeyType="f16"
        kvValueType="f16"
        selected={1024}
      />,
    );
    expect(html).toContain("EmbeddingGemma 2");
    expect(html).toContain("Qwen3-Embedding-0.6B");
    expect(html).toContain("Recommended");
    expect(html).toContain("Lower memory option");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("90%");
  });
});

it("matches estimates and applied runtimes by explicit model identity", () => {
  const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
  const qwen = {
    ...config,
    modelId: "qwen3-embedding-0.6b-q8_0",
    bytes: 1,
    source: "estimated",
    percent: 10,
    level: "ok",
  } as const;
  const gemma = { ...qwen, modelId: "embeddinggemma-2-q8_0", level: "block" } as const;
  const current = status({
    runtime: { ...status({}).runtime, ...config },
    estimates: [qwen, gemma],
  });
  expect(runtimeSelection(current, gemma)).toMatchObject({
    row: gemma,
    changed: true,
    level: "block",
    canApply: false,
  });
  expect(runtimeSelection(current, qwen)).toMatchObject({ row: qwen, changed: false });
  expect(awaitingApplied(current, gemma)).toBe(true);
});
