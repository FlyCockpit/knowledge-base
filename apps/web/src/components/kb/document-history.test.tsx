import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { actorLine, ProvenanceBadge, visibleHistoryRows } from "@/components/kb/document-history";

describe("provenance badge and history actors", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["kb"],
      defaultNS: "kb",
      resources: { "en-US": { kb: enKb } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });
  const render = (node: React.ReactNode) =>
    renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("names each provenance as Person, Agent, Dream or Unspecified", () => {
    for (const [value, label] of [
      ["human", "Person"],
      ["agent", "Agent"],
      ["dream", "Dream"],
      ["absent", "Unspecified"],
    ] as const) {
      const markup = render(<ProvenanceBadge provenance={value} />);
      expect(markup).toContain(`>${label}<`);
      expect(markup).toContain(`data-provenance="${value}"`);
    }
    expect(render(<ProvenanceBadge provenance="agent" prefix="Before" />)).toContain(
      "Before: Agent",
    );
  });

  it("says who acted: a person via web, via a credential, or unattributed", () => {
    const t = i18n.getFixedT("en-US", "kb");
    expect(actorLine(t, { kind: "web", name: "Ana", via: null })).toBe("Ana in the web app");
    expect(actorLine(t, { kind: "credential", name: "Ana", via: "laptop" })).toBe(
      "Ana via credential “laptop”",
    );
    // A credential named "web" never reads like the browser.
    expect(actorLine(t, { kind: "credential", name: "Ana", via: "web" })).toBe(
      "Ana via credential “web”",
    );
    expect(actorLine(t, { kind: "credential", name: null, via: null })).toBe(
      "Unknown person via a credential",
    );
    expect(actorLine(t, { kind: "unattributed", name: "x", via: "y" })).toBe(
      enKb.history.unattributed,
    );
  });

  it("has Spanish text for every new key", () => {
    expect(Object.keys(esKb.provenance).sort()).toEqual(Object.keys(enKb.provenance).sort());
    expect(esKb.provenance.human.label).toBe("Persona");
    expect(Object.keys(esKb.history).sort()).toEqual(Object.keys(enKb.history).sort());
    expect(esKb.pr.files.writtenBy).toBeTruthy();
    const es = i18n.cloneInstance({ lng: "es-MX" });
    es.addResourceBundle("es-MX", "kb", esKb);
    const tEs = es.getFixedT("es-MX", "kb");
    expect(actorLine(tEs, { kind: "web", name: "Ana", via: null })).toBe(
      "Ana en la aplicación web",
    );
    expect(actorLine(tEs, { kind: "credential", name: "Ana", via: "web" })).toBe(
      "Ana mediante la credencial “web”",
    );
  });
});

describe("history rows after a denial", () => {
  it("hides every loaded row once access is denied, and keeps them on other errors", () => {
    const pages = [{ items: [1, 2] }, { items: [3] }];
    expect(visibleHistoryRows(pages, false)).toEqual([1, 2, 3]);
    expect(visibleHistoryRows(pages, true)).toEqual([]);
    expect(visibleHistoryRows(undefined, false)).toEqual([]);
  });
});
