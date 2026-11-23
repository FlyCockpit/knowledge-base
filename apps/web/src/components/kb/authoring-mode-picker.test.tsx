import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { AclPicker } from "@/components/kb/acl-picker";
import { AuthoringModePicker, AuthoringModeSummary } from "@/components/kb/authoring-mode-picker";
import { DeviceApproval } from "@/components/kb/device-approval";
import { type DeviceClaim, deviceGrant, deviceWriteModes } from "@/hooks/use-device-approval";
import {
  type CredentialSelection,
  emptySelection,
  type LiveKbOption,
  selectionIssues,
  selectionReducer,
} from "@/hooks/use-mcp-consent";
import { renderWithTestRouter } from "@/lib/router-test-utils";

const writeMode = enSettings.credentials.writeMode;
const KB_A = "a".repeat(24);
const live: LiveKbOption[] = [{ kbId: KB_A, name: "Alpha notes", bits: ["read", "write"] }];
const radios = (markup: string) => markup.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];

describe("AuthoringModePicker", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["consent", "settings", "common"],
      defaultNS: "settings",
      resources: { "en-US": { consent: enConsent, settings: enSettings } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });
  const render = (node: React.ReactNode) =>
    renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("offers dream, edit and both with explanations, and preselects nothing", () => {
    const markup = render(<AuthoringModePicker value={null} onChange={() => undefined} />);
    expect(radios(markup)).toHaveLength(3);
    for (const radio of radios(markup)) expect(radio).not.toMatch(/checked/);
    for (const mode of ["dream", "edit", "both"] as const) {
      expect(markup).toContain(writeMode.modes[mode].label);
      expect(markup).toContain(writeMode.modes[mode].description.replaceAll("'", "&#x27;"));
    }
    expect(markup).toContain(writeMode.legend);
    expect(markup).not.toContain(writeMode.limited);
    // Every option is a 44px touch target.
    expect(markup.match(/<label[^>]*min-h-\[44px\]/g)).toHaveLength(3);
  });

  it("checks exactly the chosen mode", () => {
    const markup = render(<AuthoringModePicker value="edit" onChange={() => undefined} />);
    const checked = radios(markup).filter((radio) => /checked/.test(radio));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="edit"');
  });

  it("offers only the allowed modes and says why", () => {
    const markup = render(
      <AuthoringModePicker value={null} onChange={() => undefined} allowed={["dream"]} />,
    );
    expect(radios(markup)).toHaveLength(1);
    expect(radios(markup)[0]).toContain('value="dream"');
    expect(markup).not.toContain(writeMode.modes.edit.label);
    expect(markup).toContain(writeMode.limited);
  });

  it("is disabled with its reason while locked", () => {
    const markup = render(
      <AuthoringModePicker
        value="both"
        onChange={() => undefined}
        disabled
        lockedReason="Temporary access keeps the current write mode."
      />,
    );
    for (const radio of radios(markup)) expect(radio).toMatch(/disabled/);
    expect(markup).toContain("Temporary access keeps the current write mode.");
  });

  it("summarizes a credential's mode in lists, and nothing when read-only", () => {
    expect(render(<AuthoringModeSummary mode="dream" />)).toContain(
      `Write mode: ${writeMode.modes.dream.label}`,
    );
    expect(render(<AuthoringModeSummary mode={null} />)).toBe("");
  });

  it("appears in the credential picker only with write access, limited by `authoringModes`", () => {
    const html = (selection: CredentialSelection, extra = {}) =>
      render(
        <AclPicker
          live={live}
          selection={selection}
          onChange={() => undefined}
          scopeMode="select"
          {...extra}
        />,
      );
    expect(radios(html(emptySelection()))).toHaveLength(0);
    const write = selectionReducer(emptySelection(), { type: "toggleScope", scope: "mcp:write" });
    expect(radios(html(write, { writeScopeSelected: true }))).toHaveLength(3);
    expect(
      radios(html(write, { writeScopeSelected: true, authoringModes: deviceWriteModes("edit") })),
    ).toHaveLength(1);
  });

  it("previews no direct-edit tools for a dream-only write mode", () => {
    const html = (mode: "dream" | "both") => {
      let selection = selectionReducer(emptySelection(), {
        type: "toggleScope",
        scope: "mcp:write",
      });
      for (const action of [
        { type: "setToolGroups", groups: ["read", "edit", "assets", "pull_requests"] },
        { type: "toggleBit", kbId: KB_A, bit: "write" },
        { type: "setAuthoringMode", mode },
      ] as const)
        selection = selectionReducer(selection, action);
      return render(
        <AclPicker
          live={live}
          selection={selection}
          onChange={() => undefined}
          scopeMode="select"
          writeScopeSelected
        />,
      );
    };
    const both = html("both");
    const dream = html("dream");
    for (const tool of ["knowledge_documents_update", "knowledge_upload_begin"]) {
      expect(both).toContain(`<li>${tool}</li>`);
      expect(dream).not.toContain(`<li>${tool}</li>`);
    }
    // Tools a dream can still use stay listed (changes_apply's dream mode,
    // PR reviews short of a merge).
    for (const tool of ["knowledge_changes_apply", "knowledge_pull_requests_review"])
      expect(dream).toContain(`<li>${tool}</li>`);
  });

  it("keeps the surrounding submit disabled until a mode is chosen (device approval)", () => {
    const claim: DeviceClaim = {
      userCode: "ABCD2345",
      clientId: "kb-cli",
      scopes: ["mcp:read", "mcp:write"],
      nonce: "n",
      requestedWriteMode: null,
    };
    const noop = () => undefined;
    const approveButton = (selection: CredentialSelection) => {
      const issues = selectionIssues(deviceGrant(selection, live, claim.scopes));
      const markup = renderWithTestRouter(
        <I18nextProvider i18n={i18n}>
          <DeviceApproval
            phase={{ kind: "review" }}
            claim={claim}
            live={live}
            kbs={{
              isError: false,
              hasNextPage: false,
              isFetchingNextPage: false,
              onRetry: noop,
              onLoadMore: noop,
            }}
            selection={selection}
            onChange={noop}
            issues={issues}
            onApprove={noop}
            onDeny={noop}
            onRetry={noop}
            onReviewAgain={noop}
            onSignIn={noop}
          />
        </I18nextProvider>,
      );
      const buttons = markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
      return { markup, approve: buttons.find((b) => b.includes(enConsent.device.approve)) };
    };
    const none = approveButton(emptySelection());
    expect(none.approve).toMatch(/disabled=""/);
    expect(none.markup).toContain(enSettings.credentials.picker.issues.writeModeRequired);
    const chosen = approveButton(
      selectionReducer(emptySelection(), { type: "setAuthoringMode", mode: "dream" }),
    );
    expect(chosen.approve).toBeDefined();
    expect(chosen.approve).not.toMatch(/disabled=""/);
  });
});
