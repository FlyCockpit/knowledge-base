import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { SearchAllLimitForm } from "@/components/kb/search-all-limit-admin-panel";

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

describe("knowledge_search_all limit admin form", () => {
  it("renders one numeric field with the stored limit, its range and default", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <SearchAllLimitForm view={{ limit: 24, default: 16, max: 64 }} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(html.match(/data-testid="search-all-limit-form"/g)).toHaveLength(1);
    expect(html.match(/inputMode="numeric"|inputmode="numeric"/g)).toHaveLength(1);
    expect(html).toMatch(/autoComplete="off"|autocomplete="off"/);
    expect(html).toContain('value="24"');
    expect(html).toContain("From 1 to 64. Default 16.");
    expect(html).toContain(enAdmin.settings.searchAllLimit.label);
  });
});
