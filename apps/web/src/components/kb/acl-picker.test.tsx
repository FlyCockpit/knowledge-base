import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import esSettings from "@knowledge-base/locales/src/es-MX/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { AclPicker } from "@/components/kb/acl-picker";
import {
  type CredentialSelection,
  emptySelection,
  type LiveKbOption,
  selectionReducer,
} from "@/hooks/use-mcp-consent";

const KB_A = "a".repeat(24);
const KB_B = "b".repeat(24);
// A custom tool-group set has no preset permission ceiling, so every held bit is offered.
// Advanced stays open for it: 7 group checkboxes (OAuth: no sealed group).
const custom = () =>
  selectionReducer(emptySelection(), { type: "setToolGroups", groups: ["read", "edit"] });
const GROUP_BOXES = 7;
const live: LiveKbOption[] = [
  { kbId: KB_A, name: "Alpha notes", bits: ["read", "propose", "write", "review", "manage"] },
  { kbId: KB_B, name: "Beta notes", bits: ["read"] },
];
describe("AclPicker", () => {
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

  function html(
    selection: CredentialSelection,
    extra: Partial<Parameters<typeof AclPicker>[0]> = {},
  ): string {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <AclPicker
          live={live}
          selection={selection}
          onChange={() => undefined}
          scopeMode="select"
          {...extra}
        />
      </I18nextProvider>,
    );
  }

  it("renders every live KB with its held bits and nothing checked by default", () => {
    const markup = html(custom());
    expect(markup).toContain("Alpha notes");
    expect(markup).toContain("Beta notes");
    expect(markup.match(/aria-checked="true"/g)?.length).toBe(2); // the two chosen groups
    // 5 bits for Alpha + 1 for Beta + 2 scopes + create toggle; no sealed recipient
    expect(markup.match(/role="checkbox"/g)?.length).toBe(9 + GROUP_BOXES);
    expect(markup).not.toMatch(/recipient|sealed/i);
  });

  it("explicitly states that an empty selection grants no existing knowledge base", () => {
    expect(html(emptySelection())).toContain(enSettings.credentials.picker.emptyAcl);
    const one = selectionReducer(emptySelection(), { type: "toggleBit", kbId: KB_B, bit: "read" });
    expect(html(one)).not.toContain(enSettings.credentials.picker.emptyAcl);
  });

  it("never offers an implicit 'all knowledge bases' choice", () => {
    expect(html(emptySelection()).toLowerCase()).not.toContain("all knowledge bases");
  });

  it("explains write versus review", () => {
    const markup = html(custom());
    expect(markup).toContain(enSettings.credentials.picker.bits.write.description);
    expect(markup).toContain(enSettings.credentials.picker.bits.review.description);
    expect(enSettings.credentials.picker.bits.write.description).not.toBe(
      enSettings.credentials.picker.bits.review.description,
    );
  });

  it("checks exactly the selected bits", () => {
    const s = selectionReducer(custom(), { type: "toggleBit", kbId: KB_A, bit: "review" });
    expect(html(s).match(/aria-checked="true"/g)?.length).toBe(3);
  });

  it("shows created-KB bits only after create is explicitly enabled", () => {
    const off = html(emptySelection(), { writeScopeSelected: true });
    expect(off).not.toContain(enSettings.credentials.picker.createdBitsLegend);
    const on = html(selectionReducer(emptySelection(), { type: "setAllowCreate", value: true }), {
      writeScopeSelected: true,
    });
    expect(on).toContain(enSettings.credentials.picker.createdBitsLegend);
  });

  it("hides scope checkboxes when the scopes are fixed by a signed request", () => {
    const markup = html(custom(), { scopeMode: "fixed", fixedScopes: ["mcp:read"] });
    expect(markup).toContain(enSettings.credentials.picker.scopes.read);
    // 6 KB bits + create toggle (the recipient row is gone)
    expect(markup.match(/role="checkbox"/g)?.length).toBe(7 + GROUP_BOXES);
  });

  it("names every checkbox for assistive tech", () => {
    const markup = html(custom());
    const boxes = [...markup.matchAll(/<span[^>]*role="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes.length).toBe(9 + GROUP_BOXES);
    const named: string[] = [];
    for (const box of boxes) {
      const labelledBy = /aria-labelledby="([^"]+)"/.exec(box)?.[1];
      expect(labelledBy).toBeTruthy();
      expect(markup).toContain(`id="${labelledBy}"`);
      const name = new RegExp(`id="${labelledBy}"[^>]*>([^<]+)<`).exec(markup)?.[1];
      if (labelledBy?.endsWith("-name") && name) named.push(name);
    }
    // Per-KB permissions repeat the same labels, so their names carry the KB.
    expect(named).toEqual([
      "Alpha notes: Read",
      "Alpha notes: Propose",
      "Alpha notes: Write",
      "Alpha notes: Review",
      "Alpha notes: Manage",
      "Beta notes: Read",
    ]);
  });

  it("a preset caps the offered permissions: Read offers Read only, Propose never Write or Manage", () => {
    const read = html(emptySelection());
    // Read on each KB + 2 scopes + create toggle; Advanced is collapsed for a preset.
    expect(read.match(/role="checkbox"/g)?.length).toBe(5);
    expect(read).not.toContain(enSettings.credentials.picker.bits.write.description);
    const propose = html(
      selectionReducer(emptySelection(), {
        type: "setToolGroups",
        groups: ["read", "edit", "pull_requests"],
      }),
    );
    expect(propose).toContain(enSettings.credentials.picker.bits.propose.description);
    expect(propose).not.toContain(enSettings.credentials.picker.bits.write.description);
    expect(propose).not.toContain(enSettings.credentials.picker.bits.manage.description);
  });

  it("has every picker string localized in es-MX", () => {
    const keys = (o: object, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`],
      );
    expect(keys(esSettings.credentials).sort()).toEqual(keys(enSettings.credentials).sort());
  });
});
