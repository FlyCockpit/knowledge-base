import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { ApiKeyNextSteps } from "@/components/kb/api-key-next-steps";
import { KB_DOCS } from "@/lib/mcp-connect";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["settings"],
    defaultNS: "settings",
    resources: { "en-US": { settings: enSettings } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (ceiling: React.ComponentProps<typeof ApiKeyNextSteps>["ceiling"]) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ApiKeyNextSteps serverUrl="https://kb.example.com" ceiling={ceiling} />
    </I18nextProvider>,
  );

describe("ApiKeyNextSteps", () => {
  it("shows how to mint a token within the key's ceiling, with the API reference", () => {
    const html = render({
      reach: "all",
      bits: ["propose"],
      childToolGroups: ["read", "edit", "pull_requests"],
      childAuthoringMode: "edit",
    });
    expect(html).toContain(enSettings.apiKeys.next.mintTitle);
    expect(html).toContain("https://kb.example.com/api/v1/kbs/$KB_ID/tokens");
    expect(html).toContain("&quot;authoringMode&quot;:&quot;edit&quot;");
    expect(html).toContain(`href="${KB_DOCS.restApi}"`);
    expect(html).toContain('href="https://kb.example.com/api/v1/openapi.json"');
    expect(html).not.toContain("kbk_");
  });

  it("tells a key limited to the KBs it creates to create one first", () => {
    const html = render({
      reach: "created",
      bits: ["read"],
      childToolGroups: ["read"],
      childAuthoringMode: null,
    });
    expect(html).toContain(
      enSettings.apiKeys.next.mintCreatedHint.replaceAll("'", "&#x27;").replaceAll('"', "&quot;"),
    );
    expect(html).toContain("&quot;slug&quot;:&quot;my-project&quot;");
  });

  it("shows how to check a key that can't mint", () => {
    const html = render(null);
    expect(html).toContain(enSettings.apiKeys.next.checkTitle);
    expect(html).toContain("https://kb.example.com/api/v1/key");
    expect(html).not.toContain("/tokens");
  });
});
