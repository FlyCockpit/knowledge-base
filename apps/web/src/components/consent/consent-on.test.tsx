import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * With the switch on (an app that sets `ANALYTICS_PROVIDER`), withdrawal is as
 * easy as consent: the public footer and Settings render the real Cookie
 * preferences control, and it clears the stored decision so the banner comes
 * back. consent-off.test.tsx pins the shipped default (all of it absent).
 */
const reset = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  analyticsConfigured: true,
}));
vi.mock("@/hooks/use-consent", () => ({
  useConsent: () => ({ analytics: false, decided: true, accept: vi.fn(), reject: vi.fn(), reset }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { ConsentPreferencesButton } = await import(
  "@/components/consent/consent-preferences-button"
);
const { ConsentPreferencesSection } = await import(
  "@/components/consent/consent-preferences-section"
);
const { PublicFooter } = await import("@/components/public-footer");

beforeEach(() => {
  reset.mockClear();
});

describe("with an analytics provider, Cookie preferences is offered everywhere", () => {
  it("in the public footer, so anonymous visitors can withdraw", () => {
    const footer = renderToStaticMarkup(<PublicFooter />);
    expect(footer).toMatch(/<button\b[^>]*>[^<]*preferences\.open<\/button>/);
  });

  it("in Settings, with its heading and description", () => {
    const section = renderToStaticMarkup(<ConsentPreferencesSection />);
    expect(section).toContain("preferences.title");
    expect(section).toContain("preferences.description");
    expect(section).toMatch(/<button\b[^>]*>[^<]*preferences\.open<\/button>/);
  });

  it("and the control clears the stored decision, so the banner asks again", () => {
    const button = ConsentPreferencesButton({}) as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(reset).toHaveBeenCalledOnce();
  });
});
