import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import esSettings from "@knowledge-base/locales/src/es-MX/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { CliInstall, cliInstallCommands } from "@/components/kb/cli-install";

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

describe("cliInstallCommands", () => {
  it("pipes this server's installers into the shell", () => {
    expect(cliInstallCommands("https://kb.example.com")).toEqual({
      unix: "curl -fsSL https://kb.example.com/install.sh | sh",
      windows: "irm https://kb.example.com/install.ps1 | iex",
    });
  });

  it("keeps an IPv6 literal host from being read as a curl glob", () => {
    expect(cliInstallCommands("http://[::1]:3000")).toEqual({
      unix: "curl -fsSLg 'http://[::1]:3000/install.sh' | sh",
      windows: "irm 'http://[::1]:3000/install.ps1' | iex",
    });
  });

  it("keeps only the origin", () => {
    expect(cliInstallCommands("https://user:pw@kb.example.com:8443/x?y#z").unix).toBe(
      "curl -fsSL https://kb.example.com:8443/install.sh | sh",
    );
  });
});

describe("CliInstall", () => {
  it("shows both one-line commands with translated labels", async () => {
    for (const lng of ["en-US", "es-MX"]) {
      await i18n.changeLanguage(lng);
      const out = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <CliInstall origin="https://kb.example.com" />
        </I18nextProvider>,
      );
      expect(out).toContain("curl -fsSL https://kb.example.com/install.sh | sh");
      expect(out).toContain("irm https://kb.example.com/install.ps1 | iex");
      expect(out).not.toContain("cli.");
    }
  });
});
