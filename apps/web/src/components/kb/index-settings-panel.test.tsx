import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  IndexSettingsPanel,
  IndexSettingsSummary,
  QUANTIZATIONS,
  quantizationRefusal,
  quantizationRequest,
  refreshSettingsOnDenial,
  refusalReasonOf,
} from "@/components/kb/index-settings-panel";
import { usePayloadAttemptKey } from "@/hooks/use-payload-attempt-key";
import { orpc } from "@/utils/orpc";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const settings = (over: Record<string, unknown> = {}) => ({
  quantization: "binary_int8_rescore" as const,
  limit: null as number | null,
  effectiveLimit: 400_000,
  maxLimit: 400_000,
  caps: { int8: 200_000, binary_int8_rescore: 400_000 },
  defaultLimit: 400_000,
  activeChunkCount: null as number | null,
  canConfigureLimit: true,
  buildFailure: null as "CHUNK_LIMIT" | "DISK_FULL" | null,
  ...over,
});

describe("quantization refusal", () => {
  it("mirrors the server rules for each option", () => {
    const caps = { int8: 200_000, binary_int8_rescore: 400_000 };
    const stored = settings({ limit: 300_000, caps });
    expect(quantizationRefusal(stored, "int8")).toBe("CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND");
    expect(quantizationRefusal(stored, "binary_int8_rescore")).toBeNull();
    const large = settings({ caps, activeChunkCount: 200_001, limit: null });
    expect(quantizationRefusal(large, "int8")).toBe("ACTIVE_INDEX_TOO_LARGE");
    expect(quantizationRefusal(settings({ caps, activeChunkCount: 200_000 }), "int8")).toBeNull();
    expect(QUANTIZATIONS).toEqual(["int8", "binary_int8_rescore"]);
  });

  it("reads only known refusal reasons from the error data", () => {
    expect(refusalReasonOf({ data: { reason: "ACTIVE_INDEX_TOO_LARGE" } })).toBe(
      "ACTIVE_INDEX_TOO_LARGE",
    );
    expect(refusalReasonOf({ data: { reason: "<script>" } })).toBeNull();
    expect(refusalReasonOf(null)).toBeNull();
  });
});

describe("index settings summary", () => {
  it("shows the quantization, default limit and no failure", () => {
    const html = render(<IndexSettingsSummary settings={settings()} />);
    expect(html).toContain("Binary search with int8 rescoring");
    expect(html).toContain("(default)");
    expect(html).not.toContain("index-build-failure");
  });

  it("shows the int8 default clamped from 400k to 200k", () => {
    const html = render(
      <IndexSettingsSummary
        settings={settings({
          quantization: "int8",
          effectiveLimit: 200_000,
          maxLimit: 200_000,
        })}
      />,
    );
    expect(html).toContain("200,000");
    expect(html).toContain("(default)");
    expect(html).not.toContain("400,000");
  });

  it("explains a clamped stored limit and a chunk-limit build failure", () => {
    const html = render(
      <IndexSettingsSummary
        settings={settings({
          limit: 900_000,
          effectiveLimit: 400_000,
          buildFailure: "CHUNK_LIMIT",
        })}
      />,
    );
    expect(html).toContain('data-failure="CHUNK_LIMIT"');
    expect(html).toContain(enKb.settings.index.buildFailure.CHUNK_LIMIT);
    expect(html).toMatch(/stored limit of 900,000/);
  });
});

function IdempotencyKeyHarness({ keys }: { keys: string[] }) {
  const attempt = usePayloadAttemptKey();
  // 1. int8 is sent; it commits but the response is lost (no settle).
  keys.push(quantizationRequest("k".repeat(24), "int8", attempt.keyFor).idempotencyKey);
  // 2. identical retry: same key, so the server replays its receipt.
  keys.push(quantizationRequest("k".repeat(24), "int8", attempt.keyFor).idempotencyKey);
  // 3. the user picks another quantization: a new key, never IDEMPOTENCY_MISMATCH.
  keys.push(
    quantizationRequest("k".repeat(24), "binary_int8_rescore", attempt.keyFor).idempotencyKey,
  );
  // 4. after a confirmed success the key is settled; the next change is fresh.
  attempt.settle();
  keys.push(
    quantizationRequest("k".repeat(24), "binary_int8_rescore", attempt.keyFor).idempotencyKey,
  );
  return null;
}

describe("quantization idempotency key", () => {
  it("replays the key after a lost response and renews it for a changed selection", () => {
    const keys: string[] = [];
    render(<IdempotencyKeyHarness keys={keys} />);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[2]);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe("settings after a build settles", () => {
  it("re-explains the failure and re-evaluates refusals from refreshed settings", () => {
    const caps = { int8: 200_000, binary_int8_rescore: 400_000 };
    const before = settings({ caps, activeChunkCount: 200_000 });
    expect(quantizationRefusal(before, "int8")).toBeNull();
    expect(render(<IndexSettingsSummary settings={before} />)).not.toContain("index-build-failure");
    const after = settings({ caps, activeChunkCount: 200_001, buildFailure: "DISK_FULL" });
    expect(quantizationRefusal(after, "int8")).toBe("ACTIVE_INDEX_TOO_LARGE");
    expect(render(<IndexSettingsSummary settings={after} />)).toContain(
      enKb.settings.index.buildFailure.DISK_FULL,
    );
  });
});

describe("ownership loss while read remains", () => {
  it("refetches settings on a denied owner edit so the limit control disappears", async () => {
    const kbId = "k".repeat(24);
    const kb = { id: kbId, capabilities: ["read"] as const };
    const queryClient = new QueryClient();
    const settingsKey = orpc.kbIndex.settings.queryKey({ input: { kbId } });
    queryClient.setQueryData(settingsKey, settings({ canConfigureLimit: true }));
    const page = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <IndexSettingsPanel kb={kb} onDenied={() => {}} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    expect(page()).toContain('data-testid="index-limit-edit"');
    // A non-denial leaves the cache alone.
    expect(refreshSettingsOnDenial(queryClient, kbId, { code: "BAD_REQUEST" })).toBe(false);
    expect(queryClient.getQueryState(settingsKey)?.isInvalidated).toBe(false);
    // Ownership was transferred: the edit is denied and the settings are refetched.
    expect(refreshSettingsOnDenial(queryClient, kbId, { code: "FORBIDDEN" })).toBe(true);
    expect(queryClient.getQueryState(settingsKey)?.isInvalidated).toBe(true);
    await queryClient.fetchQuery({
      queryKey: settingsKey,
      queryFn: () => settings({ canConfigureLimit: false }),
    });
    const after = page();
    expect(after).not.toContain('data-testid="index-limit-edit"');
    expect(after).toContain('data-testid="index-settings-summary"');
  });
});
