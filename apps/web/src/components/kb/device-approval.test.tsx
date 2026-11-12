import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import esConsent from "@knowledge-base/locales/src/es-MX/consent.json";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DeviceApproval,
  type DeviceApprovalProps,
  DeviceCodeForm,
} from "@/components/kb/device-approval";
import type { DevicePhase } from "@/hooks/use-device-approval";
import { emptySelection, type LiveKbOption, selectionReducer } from "@/hooks/use-mcp-consent";
import { renderWithTestRouter as renderToStaticMarkup } from "@/lib/router-test-utils";

const KB_A = "a".repeat(24);
const live: LiveKbOption[] = [{ kbId: KB_A, name: "Alpha notes", bits: ["read", "write"] }];
const device = enConsent.device;
/** Static markup escapes apostrophes. */
const esc = (text: string) => text.replaceAll("'", "&#x27;");

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("DeviceApproval", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["consent", "settings", "common"],
      defaultNS: "consent",
      resources: { "en-US": { consent: enConsent, settings: enSettings } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

  function html(phase: DevicePhase, extra: Partial<DeviceApprovalProps> = {}): string {
    const noop = () => undefined;
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DeviceApproval
          phase={phase}
          claim={{ userCode: "ABCD2345", clientId: "kb-cli", scopes: ["mcp:read"], nonce: "n" }}
          live={live}
          kbs={{
            isError: false,
            hasNextPage: false,
            isFetchingNextPage: false,
            onRetry: noop,
            onLoadMore: noop,
          }}
          selection={emptySelection()}
          onChange={noop}
          issues={[]}
          onApprove={noop}
          onDeny={noop}
          onRetry={noop}
          onReviewAgain={noop}
          onSignIn={noop}
          {...extra}
        />
      </I18nextProvider>,
    );
  }

  it("review shows the code to compare, the requesting CLI and an unselected picker", () => {
    const markup = html({ kind: "review" });
    expect(markup).toContain("ABCD-2345");
    expect(markup).toContain("kb-cli");
    expect(markup).toContain("Alpha notes");
    expect(markup).not.toMatch(/aria-checked="true"/);
    expect(markup).toContain(device.approve);
    expect(markup).toContain(device.deny);
    expect(markup).toContain(device.notAToken);
    expect(markup).not.toMatch(/all knowledge bases/i);
  });

  it("an empty ACL is stated explicitly", () => {
    expect(html({ kind: "review" })).toContain(enSettings.credentials.picker.emptyAcl);
    const one = selectionReducer(emptySelection(), { type: "toggleBit", kbId: KB_A, bit: "read" });
    expect(html({ kind: "review" }, { selection: one })).not.toContain(
      enSettings.credentials.picker.emptyAcl,
    );
  });

  it("submitting disables every choice and both decisions", () => {
    const markup = html({ kind: "submitting", decision: "approve" });
    const boxes = markup.match(/<[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toMatch(/disabled/);
    expect(markup.match(/<button[^>]*disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain(device.approving);
  });

  it("an empty sealed-record form neither blocks approval nor warns", () => {
    const markup = html(
      { kind: "review" },
      {
        claim: {
          userCode: "ABCD2345",
          clientId: "kb-cli",
          scopes: ["mcp:read"],
          nonce: "n",
          recipientKey: {
            recipientKeyId: "00000000-0000-4000-8000-000000000001",
            recipientPublicKey: `${"A".repeat(43)}=`,
          },
        },
      },
    );
    expect(markup).toContain(device.recipients.add);
    expect(markup).not.toContain(device.recipients.draftPending);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
  });

  it("selection issues block approval and are listed", () => {
    const markup = html({ kind: "review" }, { issues: ["createNeedsRead"] });
    expect(markup).toContain(enSettings.credentials.picker.issues.createNeedsRead);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
  });

  it("changed live rights keeps the picker and explains that nothing was approved", () => {
    const markup = html({ kind: "rightsChanged" });
    expect(markup).toContain(device.rightsChanged);
    expect(markup).toContain(device.reviewAgain);
  });

  it("a claim or selection error offers retry without claiming no earlier authority", () => {
    expect(html({ kind: "error" })).toContain(esc(device.errorBody));
  });

  it("a lost decision reply immediately explains uncertainty and links token revocation", () => {
    const markup = html({ kind: "error", decisionUncertain: true });
    expect(markup).toContain(esc(device.uncertainBody));
    expect(markup).not.toContain("Nothing was approved");
    expect(markup).toContain("/en-US/settings/mcp");
  });

  const terminal: [DevicePhase, string][] = [
    [{ kind: "approved" }, device.approvedTitle],
    [{ kind: "denied" }, device.deniedTitle],
    [{ kind: "unavailable" }, device.unavailableTitle],
    [{ kind: "refused" }, device.refusedTitle],
    [{ kind: "uncertain" }, device.uncertainTitle],
    [{ kind: "signIn" }, device.signInTitle],
  ];
  it.each(terminal)("terminal state %o has its own visible copy and no picker", (phase, title) => {
    const markup = html(phase);
    expect(markup).toContain(esc(title));
    expect(markup).not.toContain('role="checkbox"');
    for (const [other, otherTitle] of terminal) {
      if (other.kind !== phase.kind) expect(markup).not.toContain(esc(otherTitle));
    }
  });

  it("the code entry form never autocompletes and names its field", () => {
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DeviceCodeForm onSubmit={() => undefined} invalid />
      </I18nextProvider>,
    );
    expect(markup).toMatch(/<input[^>]*autocomplete="off"/i);
    expect(markup).toContain(device.codeLabel);
    expect(markup).toContain(device.codeInvalid);
  });

  it("es-MX translates every device key", () => {
    expect(keys(esConsent.device).sort()).toEqual(keys(enConsent.device).sort());
  });
});
