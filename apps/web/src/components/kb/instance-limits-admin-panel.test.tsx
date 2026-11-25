import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  InstanceLimitsForm,
  type InstanceLimitsView,
  instanceLimitsPatch,
  parseLimit,
} from "@/components/kb/instance-limits-admin-panel";

const view: InstanceLimitsView = {
  createsPerHour: { value: 5, default: 5, min: 1, max: 1000 },
  ownedLiveKbs: { value: 30, default: 20, min: 1, max: 10_000 },
  childTokensPerApiKey: { value: 200, default: 200, min: 1, max: 10_000 },
};
const values = { createsPerHour: "5", ownedLiveKbs: "30", childTokensPerApiKey: "200" };

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

describe("instance limits admin form", () => {
  it("renders three numeric fields with the stored values, ranges and defaults", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <InstanceLimitsForm view={view} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(html.match(/inputMode="numeric"|inputmode="numeric"/g)).toHaveLength(3);
    expect(html.match(/autoComplete="off"|autocomplete="off"/g)).toHaveLength(3);
    expect(html).toContain('value="30"');
    expect(html).toContain("From 1 to 10,000. Default 20.");
    expect(html).toContain("From 1 to 1,000. Default 5.");
    expect(html).toContain(enAdmin.limits.fields.childTokensPerApiKey.label);
    expect(html).toContain(enAdmin.limits.save);
  });

  it("saves only the limits that changed", () => {
    expect(instanceLimitsPatch(view, values)).toEqual({});
    expect(instanceLimitsPatch(view, { ...values, createsPerHour: " 12 " })).toEqual({
      createsPerHour: 12,
    });
    expect(
      instanceLimitsPatch(view, { ...values, ownedLiveKbs: "20", childTokensPerApiKey: "50" }),
    ).toEqual({ ownedLiveKbs: 20, childTokensPerApiKey: 50 });
  });

  it("refuses anything that is not a whole number within bounds", () => {
    for (const raw of ["", "0", "1001", "1.5", "-3", "ten", "1e3"]) {
      expect(parseLimit(raw, view.createsPerHour)).toBeNull();
      expect(instanceLimitsPatch(view, { ...values, createsPerHour: raw })).toBeNull();
    }
    expect(parseLimit("1000", view.createsPerHour)).toBe(1000);
    expect(parseLimit("1", view.createsPerHour)).toBe(1);
  });
});
