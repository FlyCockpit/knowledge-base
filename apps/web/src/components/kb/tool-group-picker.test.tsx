import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { presetFor, ToolGroupPicker } from "@/components/kb/tool-group-picker";

const picker = enSettings.credentials.picker;

describe("ToolGroupPicker", () => {
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

  function html(extra: Partial<Parameters<typeof ToolGroupPicker>[0]> = {}): string {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ToolGroupPicker
          groups={["read"]}
          onChange={() => undefined}
          writeScope={false}
          allowCreate={false}
          offerSealed={false}
          kbs={[]}
          createdKbBits={[]}
          disabled={false}
          {...extra}
        />
      </I18nextProvider>,
    );
  }

  it("names the preset that exactly matches the groups, else custom", () => {
    expect(presetFor(["read"])).toBe("read");
    expect(presetFor(["read", "edit", "pull_requests"])).toBe("propose");
    expect(presetFor(["read", "edit", "assets", "pull_requests"])).toBe("direct");
    // R3-W8: Direct includes pull_requests, so the old Direct set is now custom.
    expect(presetFor(["read", "edit", "assets"])).toBe("custom");
    expect(presetFor(["read", "edit"])).toBe("custom");
    expect(presetFor([])).toBe("custom");
  });

  it("offers the three presets and previews the read tools and selected knowledge bases", () => {
    const markup = html({ kbs: [{ name: "Alpha notes", bits: ["read"] }] });
    for (const preset of ["read", "propose", "direct"] as const)
      expect(markup).toContain(picker.presets[preset].label);
    expect(markup).toContain(picker.presets.read.description);
    expect(markup).toContain("knowledge_search");
    expect(markup).not.toContain("knowledge_changes_apply");
    expect(markup).toContain("knowledge_bases_list");
    expect(markup).toContain("Alpha notes");
    // Advanced group checkboxes stay collapsed for a preset.
    expect(markup).not.toMatch(/role="checkbox"/);
  });

  it("opens Advanced for a custom set and never offers sealed values to OAuth apps", () => {
    const custom = html({ groups: ["read", "export"] });
    expect(custom).toContain(picker.presets.custom.description);
    expect(custom.match(/role="checkbox"/g)?.length).toBe(7);
    expect(custom).not.toContain(picker.groups.sealed.label);
    const pat = html({ groups: ["read", "export"], offerSealed: true });
    expect(pat.match(/role="checkbox"/g)?.length).toBe(8);
    expect(pat).toContain(picker.groups.sealed.label);
  });

  it("says the selected tools aren't usable yet instead of claiming the groups have none", () => {
    const none = html();
    expect(none).toContain(picker.previewNoUsableTools.replaceAll("'", "&#x27;"));
    expect(none).not.toContain(picker.previewNoTools);
    expect(none).toContain("Always callable");
    expect(html({ groups: [] })).toContain(picker.previewNoTools);
  });

  it("explains overlaps and tools that need write access", () => {
    const markup = html({ groups: ["read", "edit"] });
    expect(markup).toContain("Edit without Assets");
    expect(markup).toContain("knowledge_changes_apply");
    expect(markup).toContain(picker.previewNoKbs);
    expect(html({ groups: ["read", "edit"], writeScope: true })).not.toContain(
      "need the read-and-change access type",
    );
  });

  it("previews only tools a selected knowledge base has permission for", () => {
    const read = html({
      groups: ["index_admin"],
      writeScope: true,
      kbs: [{ name: "Alpha notes", bits: ["read"] }],
    });
    expect(read).toContain("No selected knowledge base has the permission");
    expect(read).toMatch(/permission these tools need[^<]*knowledge_index_rebuild/);
    const manage = html({
      groups: ["index_admin"],
      writeScope: true,
      kbs: [{ name: "Alpha notes", bits: ["manage"] }],
    });
    expect(manage).not.toContain("No selected knowledge base has the permission");
    expect(manage).toContain("<li>knowledge_index_rebuild</li>");
  });
});
