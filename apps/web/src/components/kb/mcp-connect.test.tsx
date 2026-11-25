import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import esSettings from "@knowledge-base/locales/src/es-MX/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { McpClientSetup, McpConnectCard } from "@/components/kb/mcp-connect";
import { KB_DOCS } from "@/lib/mcp-connect";

const SECRET = `kbp_${"0".repeat(16)}_${"S".repeat(43)}`;
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["settings"],
    defaultNS: "settings",
    resources: { "en-US": { settings: enSettings }, "es-MX": { settings: esSettings } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
/** Text as React writes it into static markup. */
const markupText = (text: string) => text.replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

describe("McpConnectCard", () => {
  it("shows the server URL, the Claude Code command, the protocol and the guide", () => {
    const html = render(
      <McpConnectCard serverUrl="https://kb.example.com" onUseToken={() => undefined} />,
    );
    expect(html).toContain(enSettings.connect.title);
    expect(html).toContain("https://kb.example.com/mcp");
    expect(html).toContain("claude mcp add --transport http kb https://kb.example.com/mcp");
    expect(html).toContain(
      markupText(enSettings.connect.hints.oauth.claude.replace("{{name}}", "kb")),
    );
    expect(html).toContain("2026-07-28");
    expect(html).toContain(enSettings.connect.useToken);
    expect(html).toContain(`href="${KB_DOCS.mcp}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    // No secret, and no in-app /docs link that would 404.
    expect(html).not.toContain("kbp_");
    expect(html).not.toMatch(/href="\/[^"]*docs/);
  });

  it("offers every client as a pressed/unpressed choice", () => {
    const html = render(<McpClientSetup serverUrl="https://kb.example.com" />);
    for (const label of Object.values(enSettings.connect.clients)) expect(html).toContain(label);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("is translated", async () => {
    await i18n.changeLanguage("es-MX");
    try {
      const html = render(
        <McpConnectCard serverUrl="https://kb.example.com" onUseToken={() => undefined} />,
      );
      expect(html).toContain(esSettings.connect.title);
      expect(html).toContain(esSettings.connect.useToken);
    } finally {
      await i18n.changeLanguage("en-US");
    }
  });
});

describe("McpClientSetup after a token reveal", () => {
  it("keeps the token out of the command and says where it is read from", () => {
    const html = render(<McpClientSetup serverUrl="https://kb.example.com" token={SECRET} />);
    expect(html).not.toContain(SECRET);
    expect(html).toContain("read -rs KB_MCP_TOKEN");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell reference, literally.
    expect(html).toContain("${KB_MCP_TOKEN}");
    expect(html).toContain(
      markupText(enSettings.connect.hints.token.claude.replace("{{env}}", "KB_MCP_TOKEN")),
    );
  });

  it("fills the token into the JSON for a private settings file", () => {
    const html = render(
      <McpClientSetup serverUrl="https://kb.example.com" token={SECRET} initialClient="other" />,
    );
    expect(html).toContain(`Bearer ${SECRET}`);
    expect(html).toContain(markupText(enSettings.connect.hints.token.other));
  });
});
