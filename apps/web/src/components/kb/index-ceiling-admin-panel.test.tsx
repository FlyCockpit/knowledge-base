import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { applyCeilingSaved, IndexCeilingFields } from "@/components/kb/index-ceiling-admin-panel";
import { orpc } from "@/utils/orpc";

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

describe("index ceiling admin fields", () => {
  it("renders one numeric field per quantization with its bound", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <IndexCeilingFields
            view={{
              int8: { ceiling: 200_000, bound: 200_000 },
              binary_int8_rescore: { ceiling: 400_000, bound: 400_000 },
            }}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(html.match(/data-testid="index-ceiling-row"/g)).toHaveLength(2);
    expect(html.match(/inputMode="numeric"|inputmode="numeric"/g)).toHaveLength(2);
    expect(html).toContain("Maximum 200,000");
    expect(html).toContain("Maximum 400,000");
    expect(html).toContain('value="200000"');
    expect(html).toContain(enAdmin.settings.indexCeiling.label.int8);
  });
});

describe("ceiling save", () => {
  it("refreshes every open KB's index settings, not just the ceilings", () => {
    const queryClient = new QueryClient();
    const keyA = orpc.kbIndex.settings.queryKey({ input: { kbId: "a".repeat(24) } });
    const keyB = orpc.kbIndex.settings.queryKey({ input: { kbId: "b".repeat(24) } });
    const profileKey = orpc.kbIndex.profile.queryKey({ input: { kbId: "a".repeat(24) } });
    // Cache contents are irrelevant here; only the invalidation state is asserted.
    for (const key of [keyA, keyB, profileKey])
      queryClient.setQueryData(key as readonly unknown[], { cached: true });
    const next = {
      int8: { ceiling: 100_000, bound: 200_000 },
      binary_int8_rescore: { ceiling: 300_000, bound: 400_000 },
    };
    applyCeilingSaved(queryClient, next);
    expect(queryClient.getQueryData(orpc.kbIndex.chunkCeiling.queryKey())).toEqual(next);
    expect(queryClient.getQueryState(keyA)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(keyB)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(profileKey)?.isInvalidated).toBe(false);
  });
});
