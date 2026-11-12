import { MCP_TOOL_PRESETS } from "@knowledge-base/auth/mcp-tool-groups";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { AclPicker } from "@/components/kb/acl-picker";
import { ChangeList, storedKbOptions } from "@/components/kb/grant-edit-sheet";
import { type LiveKbOption, selectionReducer } from "@/hooks/use-mcp-consent";
import { grantEditPlan, selectionFromGrant } from "@/lib/mcp-grant-edit";

const KB_A = "a".repeat(24);
const KB_B = "b".repeat(24);

describe("Edit access confirmation", () => {
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

  const plan = () => {
    const baseline = selectionFromGrant({
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: KB_A, bits: ["read"] }],
      allowCreate: false,
      createdKbBits: [],
    });
    const draft = [
      { type: "toggleScope", scope: "mcp:write" },
      { type: "setToolGroups", groups: [...MCP_TOOL_PRESETS.direct] },
      { type: "toggleBit", kbId: KB_A, bit: "write" },
      { type: "toggleBit", kbId: KB_B, bit: "read" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
    ].reduce(
      (state, action) => selectionReducer(state, action as Parameters<typeof selectionReducer>[1]),
      baseline,
    );
    return grantEditPlan(baseline, draft, {
      scopesEditable: true,
      touched: new Set([KB_A, KB_B]),
    });
  };
  const render = (node: React.ReactNode) =>
    renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("lists exactly what is added, with KB names when known and ids otherwise", () => {
    const markup = render(
      <ChangeList
        direction="added"
        changes={plan().added}
        names={new Map([[KB_A, "Alpha notes"]])}
      />,
    );
    const edit = enSettings.credentials.edit;
    const bits = enSettings.credentials.picker.bits;
    expect(markup).toContain(edit.added);
    expect(markup).toContain(enSettings.credentials.picker.scopes.write);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.edit.label} tools`);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.assets.label} tools`);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.pull_requests.label} tools`);
    expect(markup).toContain(`Alpha notes: ${bits.propose.label}, ${bits.write.label}`);
    expect(markup).toContain(`${KB_B}: ${bits.read.label}`);
    expect(markup).toContain(edit.changeCreate);
    expect(markup).toContain(bits.read.label);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.kb_admin.label} tools`);
    // Nothing already held is listed: scope, four groups (Direct's edit, assets
    // and pull_requests; kb_admin comes with create), two KBs, create, created bits.
    expect(markup.match(/<li>/g)).toHaveLength(9);
  });

  it("renders nothing when a direction has no changes", () => {
    expect(
      render(<ChangeList direction="removed" changes={plan().removed} names={new Map()} />),
    ).toBe("");
  });

  it("summarizes a preset cap instead of listing every knowledge base", () => {
    const markup = render(
      <ChangeList
        direction="removed"
        changes={{
          scopes: [],
          toolGroups: [],
          kbs: [],
          cap: { bits: ["read"], count: 257 },
          allowCreate: false,
          createdKbBits: [],
        }}
        names={new Map()}
      />,
    );
    expect(markup).toContain("Every knowledge base limited to: Read");
    expect(markup).toContain("257 knowledge bases");
  });
});

describe("Edit access: stored permissions without live authority", () => {
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
  const KB_REVOKED = "r".repeat(24);
  const KB_DOWN = "d".repeat(24);
  const snapshot = selectionFromGrant({
    scopes: ["mcp:write"],
    toolGroups: ["read", "edit"],
    acl: [
      { kbId: KB_REVOKED, bits: ["read"] },
      { kbId: KB_DOWN, bits: ["read", "propose", "write"] },
    ],
    allowCreate: false,
    createdKbBits: [],
  });
  // The share on KB_DOWN was downgraded to read; KB_REVOKED is no longer shared at all.
  const live: LiveKbOption[] = [{ kbId: KB_DOWN, name: "Downgraded notes", bits: ["read"] }];

  it("offers every stored entry, marking bits the user no longer holds as removal-only", () => {
    const { options, removalOnly } = storedKbOptions(snapshot, live);
    expect(options).toEqual([
      { kbId: KB_DOWN, name: "Downgraded notes", bits: ["read", "propose", "write"] },
      { kbId: KB_REVOKED, name: KB_REVOKED, bits: ["read"] },
    ]);
    expect(removalOnly).toEqual({ [KB_REVOKED]: ["read"], [KB_DOWN]: ["propose", "write"] });
  });

  const picker = (selection: typeof snapshot) => {
    const { options, removalOnly } = storedKbOptions(snapshot, live);
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <AclPicker
          live={options}
          selection={selection}
          onChange={() => undefined}
          removalOnly={removalOnly}
          scopeMode="select"
          writeScopeSelected
        />
      </I18nextProvider>,
    );
  };
  const box = (markup: string, kbId: string, bit: string) => {
    const match = new RegExp(`<[^>]*id="[^"]*-kb-${kbId}-${bit}"[^>]*>`).exec(markup);
    expect(match, `${kbId}/${bit}`).not.toBeNull();
    return match![0];
  };

  it("shows the revoked share and the downgraded bits checked and removable", () => {
    const markup = picker(snapshot);
    expect(markup).toContain(KB_REVOKED);
    expect(markup).toContain(enSettings.credentials.picker.kbUnavailable);
    expect(markup).toContain(enSettings.credentials.picker.removalOnly);
    for (const [kbId, bit] of [
      [KB_REVOKED, "read"],
      [KB_DOWN, "propose"],
      [KB_DOWN, "write"],
    ] as const) {
      expect(box(markup, kbId, bit)).not.toMatch(/disabled/);
    }
  });

  it("once removed, a stale bit cannot be added back; live bits stay editable", () => {
    const removed = [
      { type: "toggleBit", kbId: KB_DOWN, bit: "write" },
      { type: "toggleBit", kbId: KB_REVOKED, bit: "read" },
    ].reduce(
      (state, action) => selectionReducer(state, action as Parameters<typeof selectionReducer>[1]),
      snapshot,
    );
    const markup = picker(removed);
    expect(box(markup, KB_DOWN, "write")).toMatch(/disabled/);
    expect(box(markup, KB_REVOKED, "read")).toMatch(/disabled/);
    expect(box(markup, KB_DOWN, "read")).not.toMatch(/disabled/);
    const result = grantEditPlan(snapshot, removed, {
      scopesEditable: true,
      touched: new Set([KB_DOWN, KB_REVOKED]),
    });
    expect(result.input.acl).toEqual([
      { kbId: KB_DOWN, bits: ["read", "propose"] },
      { kbId: KB_REVOKED, bits: [] },
    ]);
    expect(result.widens).toBe(false);
  });
});
